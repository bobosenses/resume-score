// throttle/monitor_api.js
// 监控数据聚合 API -- 独立进程, 端口 3101
//
// 端点:
//   GET /health                  -> ok
//   GET /stats/throttle          -> 代理 gateway:3100/stats
//   GET /stats/vllm              -> 解析 vLLM:8003/metrics
//   GET /stats/resume?window=10m -> 调 python 查 sqlite
//   GET /stats/all?window=10m    -> 一次性聚合上面三个
//
// 全部带 CORS 头, monitor.html 跨域访问

const http = require('http');
const fs = require('fs');
const { execFile } = require('child_process');
const path = require('path');

const PORT             = parseInt(process.env.MONITOR_API_PORT || '3101', 10);
const GATEWAY_BASE     = process.env.GATEWAY_BASE || 'http://127.0.0.1:3100';
const VLLM_BASE        = process.env.VLLM_BASE_URL || 'http://127.0.0.1:8003';
const WEB_BASE         = process.env.WEB_BASE_URL || 'http://127.0.0.1:3000';
const STATS_PY         = path.join(__dirname, 'resume_stats.py');
const MONITOR_HTML     = path.join(__dirname, '..', 'web', 'monitor.html');
const STATS_CACHE_TTL  = 4000;   // 4s 缓存 (sqlite 查询有成本)
const STATS_TIMEOUT_MS = 8000;

// ===== sqlite 查询缓存 =====
const cache = new Map();  // key=window, value={ts, data}

function getResumeStats(window) {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        const cached = cache.get(window);
        if (cached && (now - cached.ts) < STATS_CACHE_TTL) {
            return resolve(cached.data);
        }
        execFile('python3', [STATS_PY, window], {timeout: STATS_TIMEOUT_MS}, (err, stdout, stderr) => {
            if (err) {
                console.error(`[resume_stats] ${window}:`, err.message, stderr);
                return reject(err);
            }
            try {
                const data = JSON.parse(stdout);
                cache.set(window, {ts: now, data});
                resolve(data);
            } catch (e) {
                reject(e);
            }
        });
    });
}

// ===== 调下游 HTTP =====
function fetchJSON(url, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname + u.search,
            method: 'GET', timeout,
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.end();
    });
}

function fetchText(url, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname + u.search,
            method: 'GET', timeout,
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.end();
    });
}

async function getThrottleStats() {
    try {
        return await fetchJSON(`${GATEWAY_BASE}/stats`);
    } catch (e) {
        return {error: `gateway unreachable: ${e.message}`};
    }
}

async function getVllmStats() {
    try {
        const text = await fetchText(`${VLLM_BASE}/metrics`);
        const g = re => { const m = text.match(re); return m ? parseFloat(m[1]) : 0; };
        return {
            running:     g(/vllm:num_requests_running\{[^}]*\}\s+([\d.]+)/),
            waiting:     g(/vllm:num_requests_waiting\{[^}]*\}\s+([\d.]+)/),
            kvUsage:     g(/vllm:kv_cache_usage_perc\{[^}]*\}\s+([\d.e+-]+)/),
            preemptions: g(/vllm:num_preemptions_total\{[^}]*\}\s+([\d.e+]+)/),
            prefixCacheQueries: g(/vllm:prefix_cache_queries_total\{[^}]*\}\s+([\d.e+]+)/),
            prefixCacheHits:    g(/vllm:prefix_cache_hits_total\{[^}]*\}\s+([\d.e+]+)/),
        };
    } catch (e) {
        return {error: `vllm unreachable: ${e.message}`};
    }
}

// ===== HTTP server =====
function cors(res) {
    res.setHeader('access-control-allow-origin',  '*');
    res.setHeader('access-control-allow-methods', 'GET,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
}

const server = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const u = new URL(req.url, `http://${req.headers.host}`);
    const p = u.pathname;

    if (p === '/health') {
        return res.end('ok\n');
    }

    if (p === '/stats/throttle') {
        const data = await getThrottleStats();
        res.setHeader('content-type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify(data));
    }

    if (p === '/stats/vllm') {
        const data = await getVllmStats();
        res.setHeader('content-type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify(data));
    }

    if (p === '/stats/resume') {
        const window = u.searchParams.get('window') || '10m';
        try {
            const data = await getResumeStats(window);
            res.setHeader('content-type', 'application/json; charset=utf-8');
            return res.end(JSON.stringify(data));
        } catch (e) {
            res.writeHead(500, {'content-type': 'application/json'});
            return res.end(JSON.stringify({error: e.message}));
        }
    }

    if (p === '/stats/all') {
        const window = u.searchParams.get('window') || '10m';
        const [throttle, vllm, resume] = await Promise.all([
            getThrottleStats(),
            getVllmStats(),
            getResumeStats(window).catch(e => ({error: e.message})),
        ]);
        res.setHeader('content-type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({throttle, vllm, resume, generatedAt: new Date().toISOString()}));
    }

    // ===== monitor.html (同源访问, 避免跨端口) =====
    if (p === '/monitor' || p === '/monitor.html' || p === '/') {
        try {
            const html = fs.readFileSync(MONITOR_HTML, 'utf8');
            res.setHeader('content-type', 'text/html; charset=utf-8');
            return res.end(html);
        } catch (e) {
            res.writeHead(500); return res.end('cannot read monitor.html: ' + e.message);
        }
    }

    // ===== /api/monitor 反代到 web/server.js (vLLM + GPU 数据) =====
    if (p === '/api/monitor') {
        try {
            const data = await fetchJSON(`${WEB_BASE}/api/monitor`, 5000);
            res.setHeader('content-type', 'application/json; charset=utf-8');
            return res.end(JSON.stringify(data));
        } catch (e) {
            res.writeHead(502, {'content-type': 'application/json'});
            return res.end(JSON.stringify({error: 'web upstream: ' + e.message}));
        }
    }

    res.writeHead(404, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: 'not found', tried: p}));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[${new Date().toISOString()}] monitor api listening on :${PORT}`);
    console.log(`  gateway: ${GATEWAY_BASE}`);
    console.log(`  vllm:    ${VLLM_BASE}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
