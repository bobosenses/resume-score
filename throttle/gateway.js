// throttle/gateway.js
// 简历打分限流网关 -- 独立进程, 监听 3100, 透传到 web/server.js (3000)
//
// 作用:
//   1. 在 /api/score-multi-round 入口加并发限流 (Semaphore)
//   2. 定期拉 vLLM /metrics, 根据 preemption / KV 使用率动态调整 capacity
//   3. 其他路径直接透传 (无限流)
//
// 改动面:
//   - rules_proxy.py 的 WEB_BASE 改为 http://127.0.0.1:3100 即可启用
//   - 网关挂了, 改回 3000 立即恢复
//
// 监控:
//   GET /health   -> ok
//   GET /stats    -> 当前 capacity / running / waiting / history

const http = require('http');

// ===== 配置 =====
const PORT          = parseInt(process.env.GATEWAY_PORT || '3100', 10);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || '127.0.0.1';
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || '3000', 10);
const VLLM_HOST     = process.env.VLLM_HOST || '127.0.0.1';
const VLLM_PORT     = parseInt(process.env.VLLM_PORT || '8003', 10);

const INIT_CAPACITY = parseInt(process.env.INIT_CAPACITY || '25', 10);
const MIN_CAPACITY  = parseInt(process.env.MIN_CAPACITY  || '8',  10);
const MAX_CAPACITY  = parseInt(process.env.MAX_CAPACITY  || '40', 10);
const MAX_WAITING   = parseInt(process.env.MAX_WAITING   || '60', 10);   // B: 队列上限, 超出返回 503
const QUEUE_WINDOW_MS = parseInt(process.env.QUEUE_WINDOW_MS || (5 * 60 * 1000)); // A: 滑动窗口 5 分钟
const TICK_MS       = parseInt(process.env.TICK_MS       || '5000', 10);
const PROXY_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT_MS || '600000', 10); // 10min, 单条简历4轮上限
// KV cache 触发阈值: 高位时主动降 cap, 防止 vLLM prefill 排队
const KV_HIGH       = parseFloat(process.env.KV_HIGH || '0.80');   // >80% 急刹 cap-=2
const KV_WARN       = parseFloat(process.env.KV_WARN || '0.70');   // >70% 轻减 cap-=1

// ===== 状态 =====
const state = {
    capacity: INIT_CAPACITY,
    running: 0,
    waiting: [],                // [{resolve, enqueueAt}]
    lastPreemptions: 0,
    bootTime: Date.now(),
    totalServed: 0,
    totalQueued: 0,
    totalRejected: 0,           // B: 被 503 拒绝的次数
    sumQueueMs: 0,
    maxQueueMs: 0,              // 累计历史最大
    recentQueues: [],           // A: 滑动窗口 [{t, ms}]
    history: [],                // [{t, from, to, reason, delta, kv}]
};

// ===== Semaphore =====
class GatewayBusyError extends Error {
    constructor(msg) { super(msg); this.code = 'GATEWAY_BUSY'; }
}

function acquire() {
    if (state.running < state.capacity) {
        state.running++;
        return Promise.resolve(0);
    }
    // B: 队列上限保护
    if (state.waiting.length >= MAX_WAITING) {
        state.totalRejected++;
        return Promise.reject(new GatewayBusyError(`queue full: waiting=${state.waiting.length} >= max=${MAX_WAITING}`));
    }
    state.totalQueued++;
    const enqueueAt = Date.now();
    return new Promise(resolve => {
        state.waiting.push({resolve: () => resolve(Date.now() - enqueueAt), enqueueAt});
    });
}
function release() {
    state.running--;
    while (state.waiting.length && state.running < state.capacity) {
        state.running++;
        state.waiting.shift().resolve();
    }
}

// A: 滑动窗口 maxQueueMs
function pruneRecentQueues() {
    const cutoff = Date.now() - QUEUE_WINDOW_MS;
    let i = 0;
    while (i < state.recentQueues.length && state.recentQueues[i].t < cutoff) i++;
    if (i > 0) state.recentQueues.splice(0, i);
}
function recordQueueSample(ms) {
    state.recentQueues.push({t: Date.now(), ms});
    // 防爆: 单窗口内不会超过 几千条, 这里 20k 兜底
    if (state.recentQueues.length > 20000) state.recentQueues.shift();
    state.sumQueueMs += ms;
    if (ms > state.maxQueueMs) state.maxQueueMs = ms;
}
function recentMaxQueueMs() {
    pruneRecentQueues();
    if (!state.recentQueues.length) return 0;
    let mx = 0;
    for (let i = 0; i < state.recentQueues.length; i++) {
        if (state.recentQueues[i].ms > mx) mx = state.recentQueues[i].ms;
    }
    return mx;
}
function recentAvgQueueMs() {
    pruneRecentQueues();
    if (!state.recentQueues.length) return 0;
    let s = 0;
    for (let i = 0; i < state.recentQueues.length; i++) s += state.recentQueues[i].ms;
    return Math.round(s / state.recentQueues.length);
}

// ===== vLLM metrics =====
function fetchMetrics() {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: VLLM_HOST, port: VLLM_PORT, path: '/metrics', method: 'GET',
            timeout: 3000,
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                const g = (re) => { const m = data.match(re); return m ? parseFloat(m[1]) : 0; };
                resolve({
                    preemptions: g(/vllm:num_preemptions_total\{[^}]*\}\s+([\d.e+]+)/),
                    kvUsage:     g(/vllm:kv_cache_usage_perc\{[^}]*\}\s+([\d.e+-]+)/),
                    vllmRunning: g(/vllm:num_requests_running\{[^}]*\}\s+([\d.]+)/),
                    vllmWaiting: g(/vllm:num_requests_waiting\{[^}]*\}\s+([\d.]+)/),
                });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('metrics timeout')); });
        req.end();
    });
}

// ===== 自适应容量调节 =====
async function tick() {
    let m;
    try { m = await fetchMetrics(); }
    catch (e) { return; }   // 拿不到 metrics 不调

    const delta = m.preemptions - state.lastPreemptions;
    // 启动时 lastPreemptions=0, 第一次 delta 会是当前累计值, 跳过
    if (state.lastPreemptions === 0) {
        state.lastPreemptions = m.preemptions;
        return;
    }
    state.lastPreemptions = m.preemptions;

    const old = state.capacity;
    let reason = '';
    if (delta > 3) {
        state.capacity = Math.max(MIN_CAPACITY, state.capacity - 2);
        reason = `preempt+${delta.toFixed(0)} (急刹)`;
    } else if (delta > 0) {
        state.capacity = Math.max(MIN_CAPACITY, state.capacity - 1);
        reason = `preempt+${delta.toFixed(0)} (轻减)`;
    } else if (m.kvUsage > KV_HIGH) {
        state.capacity = Math.max(MIN_CAPACITY, state.capacity - 2);
        reason = `KV=${(m.kvUsage*100).toFixed(0)}% (KV高位急刹)`;
    } else if (m.kvUsage > KV_WARN) {
        state.capacity = Math.max(MIN_CAPACITY, state.capacity - 1);
        reason = `KV=${(m.kvUsage*100).toFixed(0)}% (KV高位轻减)`;
    } else if (delta === 0 && m.kvUsage < 0.6 && state.waiting.length > 0) {
        state.capacity = Math.min(MAX_CAPACITY, state.capacity + 1);
        reason = `idle (有排队, KV=${(m.kvUsage*100).toFixed(0)}%, 慢加)`;
    }
    if (old !== state.capacity) {
        const entry = {t: Date.now(), from: old, to: state.capacity, reason, delta, kv: m.kvUsage,
                       waiting: state.waiting.length, running: state.running};
        state.history.push(entry);
        if (state.history.length > 200) state.history.shift();
        console.log(`[${new Date().toISOString()}] capacity ${old} → ${state.capacity}  ${reason}  waiting=${state.waiting.length} running=${state.running}`);
        // 调容量后, 立即唤醒可用槽位
        while (state.waiting.length && state.running < state.capacity) {
            state.running++;
            state.waiting.shift().resolve();
        }
    }
}
setInterval(tick, TICK_MS);

// ===== 透传 =====
function proxy(clientReq, clientRes, opts = {}) {
    return new Promise(resolve => {
        const headers = Object.assign({}, clientReq.headers);
        delete headers['host'];   // 让 node 自填 upstream host
        const upstreamReq = http.request({
            hostname: UPSTREAM_HOST, port: UPSTREAM_PORT,
            path: clientReq.url, method: clientReq.method, headers,
            timeout: PROXY_TIMEOUT_MS,
        }, upstreamRes => {
            const respHeaders = Object.assign({}, upstreamRes.headers);
            if (opts.queueMs !== undefined) respHeaders['x-throttle-queue-ms'] = String(opts.queueMs);
            respHeaders['x-throttle-running'] = String(state.running);
            respHeaders['x-throttle-capacity'] = String(state.capacity);
            clientRes.writeHead(upstreamRes.statusCode || 502, respHeaders);
            upstreamRes.pipe(clientRes);
            upstreamRes.on('end', resolve);
            upstreamRes.on('error', resolve);
        });
        upstreamReq.on('error', (e) => {
            console.error(`[proxy error] ${clientReq.method} ${clientReq.url}: ${e.message}`);
            if (!clientRes.headersSent) {
                clientRes.writeHead(502, {'content-type': 'application/json'});
                clientRes.end(JSON.stringify({error: 'gateway upstream error', detail: e.message}));
            } else {
                try { clientRes.end(); } catch (_) {}
            }
            resolve();
        });
        upstreamReq.on('timeout', () => {
            upstreamReq.destroy(new Error(`upstream timeout (${PROXY_TIMEOUT_MS}ms)`));
        });
        clientReq.pipe(upstreamReq);
        clientReq.on('error', () => { try { upstreamReq.destroy(); } catch (_) {} resolve(); });
    });
}

// ===== HTTP server =====
const server = http.createServer(async (req, res) => {
    const url = req.url || '/';

    // 网关自有端点
    if (url === '/health') {
        res.writeHead(200, {'content-type': 'text/plain'});
        return res.end('ok\n');
    }
    if (url === '/stats') {
        const uptime = Math.floor((Date.now() - state.bootTime) / 1000);
        res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
        return res.end(JSON.stringify({
            capacity: state.capacity,
            running: state.running,
            waiting: state.waiting.length,
            minCapacity: MIN_CAPACITY,
            maxCapacity: MAX_CAPACITY,
            maxWaiting: MAX_WAITING,
            uptimeSec: uptime,
            totalServed: state.totalServed,
            totalQueued: state.totalQueued,
            totalRejected: state.totalRejected,
            avgQueueMs: state.totalQueued ? Math.round(state.sumQueueMs / state.totalQueued) : 0,
            maxQueueMs: state.maxQueueMs,
            // A: 滑动窗口 (5 分钟)
            recentMaxQueueMs: recentMaxQueueMs(),
            recentAvgQueueMs: recentAvgQueueMs(),
            recentQueueCount: state.recentQueues.length,
            queueWindowMs: QUEUE_WINDOW_MS,
            history: state.history.slice(-30),
        }, null, 2));
    }

    // 仅 /api/score-multi-round 走限流; 其他路径直透
    const needsThrottle = url === '/api/score-multi-round' || url.startsWith('/api/score-multi-round?');

    if (!needsThrottle) {
        return proxy(req, res);
    }

    let queueMs;
    try {
        queueMs = await acquire();
    } catch (e) {
        if (e.code === 'GATEWAY_BUSY') {
            // B: 队列满, 让 Java 重试
            res.writeHead(503, {
                'content-type': 'application/json',
                'retry-after': '5',
                'x-throttle-reason': 'queue-full',
                'x-throttle-capacity': String(state.capacity),
                'x-throttle-waiting': String(state.waiting.length),
                'x-throttle-max-waiting': String(MAX_WAITING),
            });
            return res.end(JSON.stringify({
                error: 'gateway queue full',
                detail: e.message,
                retryAfterSec: 5,
            }));
        }
        // 其他异常 -> 500
        res.writeHead(500, {'content-type': 'application/json'});
        return res.end(JSON.stringify({error: e.message}));
    }
    recordQueueSample(queueMs);
    try {
        await proxy(req, res, {queueMs});
        state.totalServed++;
    } finally {
        release();
    }
});

server.on('clientError', (err, socket) => {
    try { socket.destroy(); } catch (_) {}
});

// ===== 优雅退出 =====
let shuttingDown = false;
function gracefulShutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${sig}] graceful shutdown, in-flight=${state.running} waiting=${state.waiting.length}`);
    server.close(() => {
        console.log('http server closed');
        process.exit(0);
    });
    // 兜底: 30s 后强退
    setTimeout(() => {
        console.error('force exit after 30s');
        process.exit(1);
    }, 30000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[${new Date().toISOString()}] throttle gateway listening on :${PORT}`);
    console.log(`  upstream: http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
    console.log(`  vllm:     http://${VLLM_HOST}:${VLLM_PORT}`);
    console.log(`  capacity: init=${INIT_CAPACITY}  min=${MIN_CAPACITY}  max=${MAX_CAPACITY}  tick=${TICK_MS}ms`);
    console.log(`  kv adapt: warn>${(KV_WARN*100).toFixed(0)}% (cap-1)  high>${(KV_HIGH*100).toFixed(0)}% (cap-2)`);
    console.log(`  queue:    max-waiting=${MAX_WAITING}  recent-window=${QUEUE_WINDOW_MS/1000}s`);
});
