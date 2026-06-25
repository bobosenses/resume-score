const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const mysql = require('mysql2/promise');

const MODEL = process.env.VLLM_MODEL || '/root/vLLM/models/Qwen3-8B-AWQ';
const VLLM_BASE = process.env.VLLM_BASE || 'http://127.0.0.1:8000';
const PORT = process.env.PORT || 3000;
const INDEX_PATH = path.join(__dirname, 'index.html');
const BENCHMARK_PATH = path.join(__dirname, 'benchmark.html');
const LOGS_PATH = path.join(__dirname, 'logs.html');
const MONITOR_PATH = path.join(__dirname, 'monitor.html');
const TEST_CASES_PATH = path.join(__dirname, '..', 'test', 'resume_test_cases.json');
const DEFAULT_TEST_CASE_PATH = path.join(__dirname, '123.txt');
const SCORING_RULES_PATH = path.join(__dirname, '..', 'config', 'scoring_rules.json');
const PARSE_RULES_PATH = path.join(__dirname, '..', 'config', 'parse_rules.json');
const SEMANTIC_MAPPINGS_TABLE = 'semantic_mappings';
const PROXY_BASE = process.env.PROXY_BASE || 'http://127.0.0.1:8000';
const RAG_BASE = process.env.RAG_BASE || 'http://127.0.0.1:8002';

// ========== MySQL 连接池 ==========
// 配置走环境变量：启动前 source ../.env.local
const mysqlPool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'nexis_ai',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
});

// ========== 加载语义对照数据（产品/职能/职级） ==========
// ========== 语义对照数据缓存（产品/职能/职级） ==========
var semanticCache = { product: '', function: '', level: '' };

async function refreshSemanticCache() {
    try {
        const [rows] = await mysqlPool.execute(
            `SELECT category, key_name, value_text FROM ${SEMANTIC_MAPPINGS_TABLE} ORDER BY category, key_name, sort_order ASC`
        );
        var maps = { product: {}, function: {}, level: {} };
        rows.forEach(function(r) {
            var cat = r.category;
            if (!maps[cat]) maps[cat] = {};
            if (!maps[cat][r.key_name]) maps[cat][r.key_name] = [];
            maps[cat][r.key_name].push(r.value_text);
        });
        for (var cat in maps) {
            var lines = [];
            for (var key in maps[cat]) {
                lines.push(key + ' → ' + maps[cat][key].join('、'));
            }
            semanticCache[cat] = lines.join('\n');
        }
        console.log('[semantic_cache] 已刷新: product=' + Object.keys(maps.product).length + '条, function=' + Object.keys(maps.function).length + '条, level=' + Object.keys(maps.level).length + '条');
    } catch (e) {
        console.error('[semantic_cache] 刷新失败:', e.message);
    }
}

// 启动时加载 + 每 60s 自动刷新
refreshSemanticCache();
setInterval(refreshSemanticCache, 60000);

// ========== Helper: call vLLM chat/completions and stream back Ollama-style generate chunks ==========
function streamChatCompletion(messages, options, res) {
    const vllmPayload = {
        model: options.model || MODEL,
        messages: messages,
        stream: true,
        max_tokens: options.max_tokens || 600,
        temperature: options.temperature !== undefined ? options.temperature : 0.1,
    };
    // temperature 为 0 时加 seed 保证完全确定性
    if (vllmPayload.temperature === 0) {
        vllmPayload.seed = 42;
    }

    if (options.thinking !== undefined) {
        vllmPayload.chat_template_kwargs = { enable_thinking: !!options.thinking };
    }

    const body = JSON.stringify(vllmPayload);
    const url = new URL(VLLM_BASE + '/v1/chat/completions');

    const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (vllmRes) => {
        res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        let buffer = '';
        vllmRes.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') return;
                try {
                    const json = JSON.parse(data);
                    const choice = json.choices && json.choices[0];
                    if (!choice) continue;

                    const content = (choice.delta && choice.delta.content) || '';
                    const isFinish = choice.finish_reason != null;

                    if (content) {
                        res.write(JSON.stringify({
                            model: json.model || vllmPayload.model,
                            response: content,
                            done: false,
                        }) + '\n');
                    }

                    if (isFinish) {
                        const usage = json.usage || {};
                        res.write(JSON.stringify({
                            model: json.model || vllmPayload.model,
                            done: true,
                            response: '',
                            eval_count: usage.completion_tokens || 0,
                            eval_duration: 0,
                            prompt_eval_count: usage.prompt_tokens || 0,
                        }) + '\n');
                    }
                } catch (e) { /* skip bad lines */ }
            }
        });

        vllmRes.on('end', () => { res.end(); });
    });

    req.on('error', (e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    });

    req.write(body);
    req.end();
}

// ========== /api/generate — prompt wrapped as user message → chat completions ==========
function proxyGenerate(payload, res) {
    let parsed;
    try { parsed = JSON.parse(payload); } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }

    const messages = [{ role: 'user', content: parsed.prompt }];
    const options = {
        model: parsed.model || MODEL,
        max_tokens: (parsed.options && parsed.options.num_predict) || 600,
        temperature: parsed.options && parsed.options.temperature !== undefined ? parsed.options.temperature : 0.1,
        thinking: parsed.thinking,
    };

    streamChatCompletion(messages, options, res);
}

// ========== /api/chat — multi-turn chat → chat completions ==========
function chatWithVLLM(messages, options, res) {
    // Output Ollama /api/chat format (message.content) instead of generate format (response)
    const vllmPayload = {
        model: options.model || MODEL,
        messages: messages,
        stream: true,
        max_tokens: options.max_tokens || 600,
        temperature: (typeof options.temperature === 'number') ? options.temperature : 0.1,
    };

    if (options.thinking !== undefined) {
        vllmPayload.chat_template_kwargs = { enable_thinking: !!options.thinking };
    }

    const body = JSON.stringify(vllmPayload);
    const url = new URL(VLLM_BASE + '/v1/chat/completions');

    const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (vllmRes) => {
        res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        let buffer = '';
        vllmRes.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') {
                    res.write(JSON.stringify({
                        model: MODEL,
                        done: true,
                        message: { role: 'assistant', content: '' },
                    }) + '\n');
                    return;
                }
                try {
                    const json = JSON.parse(data);
                    const choice = json.choices && json.choices[0];
                    if (!choice) continue;

                    const delta = choice.delta || {};
                    const content = delta.content || '';
                    const isFinish = choice.finish_reason != null;

                    if (content) {
                        res.write(JSON.stringify({
                            model: json.model || MODEL,
                            message: { role: 'assistant', content: content },
                            done: false,
                        }) + '\n');
                    }

                    if (isFinish && !content) {
                        res.write(JSON.stringify({
                            model: json.model || MODEL,
                            message: { role: 'assistant', content: '' },
                            done: true,
                        }) + '\n');
                    }
                } catch (e) { /* skip bad lines */ }
            }
        });

        vllmRes.on('end', () => { res.end(); });
    });

    req.on('error', (e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    });

    req.write(body);
    req.end();
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        try {
            const html = fs.readFileSync(INDEX_PATH, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            return res.end('Error reading index.html');
        }
    }

    if (req.method === 'GET' && (req.url === '/benchmark' || req.url === '/benchmark.html')) {
        try {
            const html = fs.readFileSync(BENCHMARK_PATH, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            return res.end('Error reading benchmark.html');
        }
    }

    if (req.method === 'GET' && (req.url === '/logs' || req.url === '/logs.html')) {
        try {
            const html = fs.readFileSync(LOGS_PATH, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            return res.end('Error reading logs.html');
        }
    }

    if (req.method === 'GET' && (req.url === '/monitor' || req.url === '/monitor.html')) {
        try {
            const html = fs.readFileSync(MONITOR_PATH, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            return res.end('Error reading monitor.html');
        }
    }


    // ========== API: 实时监控数据 ==========
    if (req.method === 'GET' && req.url === '/api/monitor') {
        try {
            var gpu = { util: 0, memUsed: 0, memFree: 0, temp: 0, power: 0 };
            try {
                var gpuOut = execSync(
                    'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.free,temperature.gpu,power.draw --format=csv,noheader',
                    { timeout: 3000 }
                ).toString().trim();
                var gpuParts = gpuOut.split(',').map(function(s) { return s.trim().replace(/[^0-9.]/g, ''); });
                if (gpuParts.length >= 5) {
                    gpu = { util: parseFloat(gpuParts[0]), memUsed: parseInt(gpuParts[1]), memFree: parseInt(gpuParts[2]), temp: parseInt(gpuParts[3]), power: parseFloat(gpuParts[4]) };
                }
            } catch (ee) { /* GPU query failed */ }

            var history = [];
            try {
                var vllmLog = execSync('tail -100 /root/vLLM/vllm.log', { timeout: 3000 }).toString();
                var lines = vllmLog.split('\n');
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i];
                    var m = line.match(/INFO\s+\d{2}-\d{2}\s+(\d{2}:\d{2}:\d{2}).*?(?:Avg\s+)?prompt throughput:\s+([\d.]+)\s+tokens\/s.*?(?:Avg\s+)?generation throughput:\s+([\d.]+)\s+tokens\/s.*?Running:\s+(\d+)\s+reqs.*?Waiting:\s+(\d+)\s+reqs.*?KV cache usage:\s+([\d.]+)%.*?Prefix cache hit rate:\s+([\d.]+)%/);
                    if (m) {
                        history.push({
                            time: m[1],
                            prompt: parseFloat(m[2]),
                            gen: parseFloat(m[3]),
                            running: parseInt(m[4]),
                            waiting: parseInt(m[5]),
                            kvCache: parseFloat(m[6]),
                            prefixHit: parseFloat(m[7])
                        });
                    }
                }
            } catch (ee) { /* log read failed */ }

            var now = history.length > 0 ? history[history.length - 1] : { prompt: 0, gen: 0, running: 0, waiting: 0, kvCache: 0, prefixHit: 0 };

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
            return res.end(JSON.stringify({ gpu: gpu, now: now, history: history.slice(-40) }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: String(e) }));
        }
    }

    if (req.method === 'GET' && req.url === '/api/benchmark') {
        try {
            const query = req.url.includes('?') ? req.url.split('?')[1] : '';
            const params = {};
            query.split('&').forEach(function(p) { if (p) { var kv = p.split('='); params[kv[0]] = kv[1] || ''; } });
            const pathToUse = params.report === 'multidim' ? REPORT_PATH : RESUME_REPORT_PATH;
            const report = fs.readFileSync(pathToUse, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
            return res.end(report);
        } catch (e) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: '报告文件未找到，请先运行压测' }));
        }
    }

    if (req.method === 'GET' && req.url === '/api/test-cases') {
        try {
            const tc = fs.readFileSync(TEST_CASES_PATH, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
            return res.end(tc);
        } catch (e) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: '测试用例文件未找到' }));
        }
    }

    // ========== 日志查询代理 ==========
    if (req.method === 'GET' && req.url.startsWith('/api/logs')) {
        const targetUrl = PROXY_BASE + req.url;
        http.get(targetUrl, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-cache'
            });
            proxyRes.pipe(res);
        }).on('error', (e) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        });
        return;
    }

    // ========== 打分规则管理 ==========
    if (req.method === 'GET' && req.url === '/api/scoring-rules') {
        try {
            const data = JSON.parse(fs.readFileSync(SCORING_RULES_PATH, 'utf8'));
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
            return res.end(JSON.stringify(data));
        } catch (e) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: '打分规则文件未找到' }));
        }
    }

    if (req.method === 'PUT' && req.url === '/api/scoring-rules') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const update = JSON.parse(body);
                let current = {};
                try { current = JSON.parse(fs.readFileSync(SCORING_RULES_PATH, 'utf8')); } catch(e) {}

                if (update.rules !== undefined) current.rules = update.rules;
                if (update.system_prompt !== undefined) current.system_prompt = update.system_prompt;
                if (update.version !== undefined) current.version = update.version;
                if (update.enabled !== undefined) current.enabled = update.enabled;

                current.updated_at = new Date().toISOString().replace('Z', '+08:00');
                fs.writeFileSync(SCORING_RULES_PATH, JSON.stringify(current, null, 2), 'utf8');

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    message: '规则更新成功',
                    version: current.version,
                    updated_at: current.updated_at,
                    rules_length: (current.rules || '').length,
                }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '无效的 JSON: ' + e.message }));
            }
        });
        return;
    }

    // ========== 解析规则管理 ==========
    if (req.method === 'GET' && req.url === '/api/parse-rules') {
        try {
            const data = JSON.parse(fs.readFileSync(PARSE_RULES_PATH, 'utf8'));
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
            return res.end(JSON.stringify(data));
        } catch (e) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: '解析规则文件未找到' }));
        }
    }

    if (req.method === 'PUT' && req.url === '/api/parse-rules') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const update = JSON.parse(body);
                let current = {};
                try { current = JSON.parse(fs.readFileSync(PARSE_RULES_PATH, 'utf8')); } catch(e) {}

                if (update.rules !== undefined) current.rules = update.rules;
                if (update.version !== undefined) current.version = update.version;
                if (update.enabled !== undefined) current.enabled = update.enabled;

                current.updated_at = new Date().toISOString().replace('Z', '+08:00');
                fs.writeFileSync(PARSE_RULES_PATH, JSON.stringify(current, null, 2), 'utf8');

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    message: '解析规则更新成功',
                    version: current.version,
                    updated_at: current.updated_at,
                    rules_length: (current.rules || '').length,
                }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '无效的 JSON: ' + e.message }));
            }
        });
        return;
    }

    // ========== 语义对照关系管理 API ==========
    // GET /api/semantic-mappings?category=product|function|level
    if (req.method === 'GET' && req.url.startsWith('/api/semantic-mappings')) {
        const query = req.url.includes('?') ? req.url.split('?')[1] : '';
        const params = {};
        query.split('&').forEach(p => { const kv = p.split('='); if (kv[0]) params[kv[0]] = decodeURIComponent(kv[1] || ''); });
        const category = params.category || '';

        (async () => {
            try {
                let sql = 'SELECT id, category, key_name, value_text, sort_order FROM ' + SEMANTIC_MAPPINGS_TABLE;
                const sqlParams = [];
                if (category && ['product','function','level'].includes(category)) {
                    sql += ' WHERE category = ?';
                    sqlParams.push(category);
                }
                sql += ' ORDER BY category, key_name, sort_order';
                const [rows] = await mysqlPool.execute(sql, sqlParams);

                // Group by key_name
                const grouped = {};
                rows.forEach(r => {
                    const k = r.category + '::' + r.key_name;
                    if (!grouped[k]) {
                        grouped[k] = { id: r.id, category: r.category, key_name: r.key_name, values: [] };
                    }
                    grouped[k].values.push(r.value_text);
                });

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
                res.end(JSON.stringify({ data: Object.values(grouped) }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '查询失败: ' + e.message }));
            }
        })();
        return;
    }

    // POST /api/semantic-mappings — 保存（覆盖式写入 values 列表）
    if (req.method === 'POST' && req.url === '/api/semantic-mappings') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            (async () => {
                try {
                    const { category, key_name, values } = JSON.parse(body);
                    if (!category || !key_name || !values || !Array.isArray(values)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: '缺少 category/key_name/values 字段' }));
                        return;
                    }
                    // 事务：先删后插
                    await mysqlPool.execute('DELETE FROM ' + SEMANTIC_MAPPINGS_TABLE + ' WHERE category=? AND key_name=?', [category, key_name]);
                    for (let i = 0; i < values.length; i++) {
                        await mysqlPool.execute(
                            'INSERT INTO ' + SEMANTIC_MAPPINGS_TABLE + ' (category, key_name, value_text, sort_order) VALUES (?,?,?,?)',
                            [category, key_name, values[i], i]
                        );
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ message: '保存成功', key_name, values, count: values.length }));
                    // 刷新缓存
                    refreshSemanticCache();
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '保存失败: ' + e.message }));
                }
            })();
        });
        return;
    }

    // DELETE /api/semantic-mappings?category=xxx&key_name=xxx
    if (req.method === 'DELETE' && req.url.startsWith('/api/semantic-mappings')) {
        const query = req.url.includes('?') ? req.url.split('?')[1] : '';
        const params = {};
        query.split('&').forEach(p => { const kv = p.split('='); if (kv[0]) params[kv[0]] = decodeURIComponent(kv[1] || ''); });
        const category = params.category || '';
        const key_name = params.key_name || '';

        (async () => {
            try {
                if (!category || !key_name) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '缺少 category/key_name 参数' }));
                    return;
                }
                await mysqlPool.execute('DELETE FROM ' + SEMANTIC_MAPPINGS_TABLE + ' WHERE category=? AND key_name=?', [category, decodeURIComponent(key_name)]);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ message: '删除成功' }));
                // 刷新缓存
                refreshSemanticCache();
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '删除失败: ' + e.message }));
            }
        })();
        return;
    }

    // ========== 简历信息拼装（textSpan → description） ==========
    if (req.method === 'POST' && req.url === '/api/assemble') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { skeleton, resume } = JSON.parse(body);
                if (!skeleton || !resume) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'skeleton 和 resume 不能为空' }));
                }

                function assembleDescriptions(experiences) {
                    if (!Array.isArray(experiences)) return;
                    for (let i = 0; i < experiences.length; i++) {
                        const exp = experiences[i];
                        const span = exp.textSpan;
                        if (!span || typeof span !== 'string') continue;

                        let start = resume.indexOf(span);
                        if (start === -1) {
                            // 模糊匹配：取前10个字符
                            const short = span.substring(0, 10);
                            start = resume.indexOf(short);
                        }

                        if (start === -1) {
                            exp.description = '';
                            delete exp.textSpan;
                            continue;
                        }

                        // 找下一段经历的起始位置作为结束边界
                        let end = resume.length;
                        if (i + 1 < experiences.length) {
                            const nextSpan = experiences[i + 1].textSpan;
                            if (nextSpan) {
                                const nextStart = resume.indexOf(nextSpan, start + 1);
                                if (nextStart !== -1) end = nextStart;
                            }
                        }

                        exp.description = resume.substring(start, end).trim();
                        delete exp.textSpan;
                    }
                }

                // 拼装 workExperience 和 projectExperience
                assembleDescriptions(skeleton.workExperience);
                assembleDescriptions(skeleton.projectExperience);

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(skeleton));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ========== 根据项目ID获取JD数据 ==========
    if (req.method === 'GET' && req.url.startsWith('/api/db/project-jd')) {
        const query = req.url.includes('?') ? req.url.split('?')[1] : '';
        const params = {};
        query.split('&').forEach(function(p) { if (p) { var kv = p.split('='); params[kv[0]] = decodeURIComponent(kv[1] || ''); } });
        const projectId = params.projectId;
        if (!projectId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'projectId 不能为空' }));
        }

        (async () => {
            try {
                const sql = `
                    SELECT
                        j.company_name, j.job_title, j.department, j.work_location,
                        j.salary_range, j.min_salary, j.max_salary, j.sex,
                        j.industry, j.product, j.min_experience_year, j.max_experience_year,
                        j.min_age, j.max_age, j.education_level, j.education_major,
                        j.hopping_time, j.deduct_percent, j.job_response, j.must_have,
                        j.prefer, j.target_company,
                        j.hard_skills, j.experience_requirement, j.similar_positions,
                        j.rank_level, j.function_label
                    FROM project p
                    JOIN jd_summary j ON p.jd_id = j.id
                    WHERE p.id = ?
                `;
                const [rows] = await mysqlPool.execute(sql, [projectId]);
                if (rows.length === 0) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: '未找到项目ID: ' + projectId }));
                }
                const r = rows[0];

                // 分段组装
                var jdParts = [];
                if (r.company_name) jdParts.push('公司名称：' + r.company_name);
                if (r.job_title) jdParts.push('职位名称：' + r.job_title);
                if (r.department) jdParts.push('需求部门：' + r.department);
                if (r.work_location) jdParts.push('工作城市：' + r.work_location);
                if (r.salary_range) jdParts.push('薪资范围：' + r.salary_range);
                if (r.min_salary) jdParts.push('最低月薪：' + r.min_salary);
                if (r.max_salary) jdParts.push('最高月薪：' + r.max_salary);
                if (r.sex) jdParts.push('性别要求：' + r.sex);
                var jdText = jdParts.join('\n');

                var mustParts = [];
                if (r.industry) mustParts.push('行业：' + r.industry);
                if (r.product) mustParts.push('产品：' + r.product);
                if (r.min_experience_year != null) mustParts.push('最低工作年限：' + r.min_experience_year);
                if (r.max_experience_year != null) mustParts.push('最高工作年限：' + r.max_experience_year);
                if (r.min_age != null) mustParts.push('最小年龄：' + r.min_age);
                if (r.max_age != null) mustParts.push('最大年龄：' + r.max_age);
                if (r.education_level) mustParts.push('学历要求：' + r.education_level);
                if (r.education_major) mustParts.push('专业要求：' + r.education_major);
                if (r.hopping_time) mustParts.push('跳槽频率：' + r.hopping_time);
                if (r.deduct_percent) mustParts.push('扣除比例：' + r.deduct_percent);
                if (r.job_response) mustParts.push('工作职责：' + r.job_response);
                if (r.must_have) mustParts.push('原始要求：' + r.must_have);
                var mustHaveText = mustParts.join('\n');

                var preferText = r.prefer || '';
                var targetCompanyText = r.target_company || '';

                // 拼成完整 JD 文本
                var fullJd = '【职位信息】\n' + jdText;
                if (mustHaveText) fullJd += '\n\n【硬性要求】\n' + mustHaveText;
                if (preferText) fullJd += '\n\n【加分项】\n' + preferText;
                if (targetCompanyText) fullJd += '\n\n【目标公司】\n' + targetCompanyText;

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    jdText: jdText,
                    mustHaveText: mustHaveText,
                    preferText: preferText,
                    targetCompanyText: targetCompanyText,
                    fullJd: fullJd,
                    raw: r,
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '数据库查询失败: ' + e.message }));
            }
        })();
        return;
    }

    // ========== 根据简历ID获取简历内容 ==========
    if (req.method === 'GET' && req.url.startsWith('/api/db/resume')) {
        const query = req.url.includes('?') ? req.url.split('?')[1] : '';
        const params = {};
        query.split('&').forEach(function(p) { if (p) { var kv = p.split('='); params[kv[0]] = decodeURIComponent(kv[1] || ''); } });
        const resumeId = params.resumeId;
        if (!resumeId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'resumeId 不能为空' }));
        }

        (async () => {
            try {
                const sql = `
                    SELECT resume_id, raw_resume_content, create_time, status
                    FROM resume_detail
                    WHERE resume_id = ?
                    ORDER BY create_time DESC
                    LIMIT 1
                `;
                const [rows] = await mysqlPool.execute(sql, [resumeId]);
                if (rows.length === 0) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: '未找到简历ID: ' + resumeId }));
                }
                const r = rows[0];
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    resumeId: r.resume_id,
                    content: r.raw_resume_content || '',
                    createTime: r.create_time,
                    status: r.status,
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '数据库查询失败: ' + e.message }));
            }
        })();
        return;
    }

    // ========== 职能分析（ChromaDB召回 + LLM判断） ==========
    if (req.method === 'POST' && req.url === '/api/function-search') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { query } = JSON.parse(body);
                if (!query) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'query 不能为空' }));
                }

                // 从简历原文中提取高密度语义段落作为搜索query
                function extractSearchQuery(text) {
                    var parts = [];
                    var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

                    // === 1. 提取职位名称（不依赖日期格式） ===
                    // 策略：扫描所有行，找含职位关键词的短行（2-20字）
                    var posKeywords = /(?:工程师|经理|主管|总监|专员|助理|设计师|分析师|架构师|技术员|研究员|咨询师|策划师)/;
                    var noiseRe = /^(查看企业|搜索同事|还有|继续沟通|职责业绩|下属人数|工作地点|简历编号|外商独资|电子\/|男\s|女\s|\d{3}岁|方便联系|继续沟通|推荐职位|查看联系|收藏|转发|向TA索要|TA上传|附件简历|声明：|未填写|搜索同学)/;
                    var positions = [];
                    for (var i = 0; i < lines.length; i++) {
                        var line = lines[i];
                        if (line.length > 25 || line.length < 2) continue;
                        if (noiseRe.test(line)) continue;
                        if (posKeywords.test(line)) {
                            // 清理：去掉行首的序号、标点等
                            var pos = line.replace(/^[①②③④⑤⑥⑦⑧⑨⑩\d]+[.、)\]】】\s]*/, '').trim();
                            if (pos.length >= 2) positions.push(pos);
                        }
                    }
                    // 去重，保留前5个
                    var seen = {};
                    positions = positions.filter(function(p) {
                        if (seen[p]) return false;
                        seen[p] = true;
                        return true;
                    }).slice(0, 5);
                    if (positions.length) parts.push(positions.join(' '));

                    // === 2. 提取自我评价/技能描述（不依赖标签名） ===
                    // 策略：找"熟悉/擅长/精通"开头的句子，或"自我评价/个人总结"标签后的内容
                    var evalText = '';
                    // 先尝试标签
                    var evalLabel = text.match(/(?:自我评价|个人总结|自我描述|个人描述|自我介绍)[：:\s]*([\s\S]{10,300}?)(?=附件简历|对方已上传|TA上传|声明：|向TA索要|我的技能|语言能力|教育经历|$)/);
                    if (evalLabel) {
                        evalText = evalLabel[1].replace(/\n/g, ' ').trim();
                    }
                    // 如果标签没找到，用语义句子兜底
                    if (!evalText || evalText.length < 10) {
                        var sentences = [];
                        var skillRe = /(?:擅长|具备|熟悉|精通|拥有|善于|多年)[一-龥a-zA-Z，,。；;：:\s（）()\/·、]{8,100}[。；;]/g;
                        var m;
                        while ((m = skillRe.exec(text)) !== null) {
                            sentences.push(m[0].trim());
                            if (sentences.length >= 3) break;
                        }
                        if (sentences.length) evalText = sentences.join(' ');
                    }
                    if (evalText) parts.push(evalText.substring(0, 150));

                    if (parts.length === 0) return text.substring(0, 500);
                    return parts.join(' ');
                }

                // 提取LLM用的简历摘要
                function extractResumeSummary(text) {
                    var summary = [];
                    var basic = text.match(/(?:\[基本信息\]|##\s*基本信息)[\s\S]{10,200}?(?=\[|##)/);
                    if (basic) summary.push(basic[0].substring(0, 150).replace(/\n/g, ' '));
                    var intent = text.match(/求职意向[\s\S]{5,80}?(?=\[|##|\n\n)/);
                    if (intent) summary.push(intent[0].replace(/\n/g, ' '));
                    var workLines = text.match(/[一-龥a-zA-Z（）\(\)·\-]+（\d{4}\.\d{2}[^）]*）[一-龥\/·（）a-zA-Z\s]+/g);
                    if (workLines) summary.push('工作经历: ' + workLines.slice(0, 8).join('; '));
                    var evalSec = text.match(/自我评价[：:]*\s*([\s\S]{10,200}?)(?=\[|【|$)/);
                    if (evalSec) summary.push('自我评价: ' + evalSec[1].trim().substring(0, 150));
                    return summary.join('\n').substring(0, 600);
                }

                var searchQuery = extractSearchQuery(query);
                var resumeSummary = extractResumeSummary(query);

                // Step 1: ChromaDB 召回 Top 20
                const ragPayload = JSON.stringify({
                    collection: 'function_labels',
                    query: searchQuery,
                    top_k: 20,
                    rerank: true,
                    rerank_top_k: 20,
                });

                const ragUrl = new URL(RAG_BASE + '/search');
                const ragReq = http.request({
                    hostname: ragUrl.hostname,
                    port: ragUrl.port,
                    path: ragUrl.pathname,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ragPayload) }
                }, (ragRes) => {
                    let ragBody = '';
                    ragRes.on('data', chunk => ragBody += chunk);
                    ragRes.on('end', () => {
                        try {
                            const ragData = JSON.parse(ragBody);
                            var candidates = ragData.results || [];

                            if (candidates.length === 0) {
                                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                                return res.end(JSON.stringify({ query, search_query: searchQuery, results: [], total: 0, elapsed_ms: ragData.elapsed_ms || 0 }));
                            }

                            // Step 2: LLM 从候选中选 Top 5
                            var candidateList = candidates.map(function(c, i) {
                                var m = c.metadata || {};
                                return (i+1) + '. ' + (m.function_path || c.document);
                            }).join('\n');

                            var llmPrompt = '你是职能匹配专家。根据简历信息，从以下候选职能中选出最匹配的Top 5。\n\n';
                            llmPrompt += '【简历信息】\n' + resumeSummary + '\n\n';
                            llmPrompt += '【候选职能列表】\n' + candidateList + '\n\n';
                            llmPrompt += '严格按以下JSON格式输出，不要解释：\n';
                            llmPrompt += '{"matches":[{"rank":1,"candidate_index":1,"confidence":"high","reason":"一句话理由"},...]}';

                            var llmPayload = JSON.stringify({
                                model: MODEL,
                                messages: [{ role: 'user', content: llmPrompt }],
                                stream: false,
                                max_tokens: 500,
                                temperature: 0.1,
                                chat_template_kwargs: { enable_thinking: false },
                            });

                            var llmUrl = new URL(VLLM_BASE + '/v1/chat/completions');
                            var llmReq = http.request({
                                hostname: llmUrl.hostname,
                                port: llmUrl.port,
                                path: llmUrl.pathname,
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(llmPayload) }
                            }, (llmRes) => {
                                let llmBody = '';
                                llmRes.on('data', chunk => llmBody += chunk);
                                llmRes.on('end', () => {
                                    try {
                                        var llmData = JSON.parse(llmBody);
                                        var llmContent = (llmData.choices && llmData.choices[0] && llmData.choices[0].message && llmData.choices[0].message.content) || '';

                                        var llmMatches = [];
                                        try {
                                            var jsonMatch = llmContent.match(/\{[\s\S]*\}/);
                                            if (jsonMatch) {
                                                var parsed = JSON.parse(jsonMatch[0]);
                                                llmMatches = parsed.matches || [];
                                            }
                                        } catch(e) {}

                                        var finalResults = [];
                                        var usedIndices = new Set();
                                        llmMatches.forEach(function(match) {
                                            var idx = (match.candidate_index || match.rank || 1) - 1;
                                            if (idx >= 0 && idx < candidates.length && !usedIndices.has(idx)) {
                                                usedIndices.add(idx);
                                                var c = candidates[idx];
                                                finalResults.push({
                                                    id: c.id, document: c.document, metadata: c.metadata,
                                                    score: c.score, rerank_score: c.rerank_score,
                                                    llm_rank: match.rank || finalResults.length + 1,
                                                    llm_confidence: match.confidence || 'medium',
                                                    llm_reason: match.reason || '',
                                                });
                                            }
                                        });
                                        for (var i = 0; i < candidates.length && finalResults.length < 5; i++) {
                                            if (!usedIndices.has(i)) {
                                                var c = candidates[i];
                                                finalResults.push({
                                                    id: c.id, document: c.document, metadata: c.metadata,
                                                    score: c.score, rerank_score: c.rerank_score,
                                                    llm_rank: finalResults.length + 1,
                                                    llm_confidence: 'low', llm_reason: '向量检索补充',
                                                });
                                            }
                                        }

                                        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                                        res.end(JSON.stringify({
                                            query, search_query: searchQuery,
                                            results: finalResults.slice(0, 5),
                                            total: finalResults.length,
                                            elapsed_ms: ragData.elapsed_ms || 0,
                                            llm_raw: llmContent,
                                        }));
                                    } catch(e) {
                                        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                                        ragData.search_query = searchQuery;
                                        ragData.results = candidates.slice(0, 5);
                                        res.end(JSON.stringify(ragData));
                                    }
                                });
                            });
                            llmReq.on('error', () => {
                                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                                ragData.search_query = searchQuery;
                                ragData.results = candidates.slice(0, 5);
                                res.end(JSON.stringify(ragData));
                            });
                            llmReq.write(llmPayload);
                            llmReq.end();

                        } catch (e) {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'RAG 响应解析失败' }));
                        }
                    });
                });
                ragReq.on('error', (e) => {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'RAG 服务不可用: ' + e.message }));
                });
                ragReq.write(ragPayload);
                ragReq.end();
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.method === 'GET' && req.url === '/api/default-test-case') {
        try {
            const content = fs.readFileSync(DEFAULT_TEST_CASE_PATH, 'utf8');
            const normalized = content.replace(/\r\n/g, '\n');
            const resumeMatch = normalized.match(/简历内容：\n\n([\s\S]*?)(?=JD内容：)/);
            const jdMatch = normalized.match(/JD内容：\n\n([\s\S]*?)(?=AI简历评估提示词)/);
            const rulesMatch = normalized.match(/AI简历评估提示词\n\n([\s\S]*)$/);
            const data = {
                resume: resumeMatch ? resumeMatch[1].trim() : '',
                jd: jdMatch ? jdMatch[1].trim() : '',
                rules: rulesMatch ? rulesMatch[1].trim() : '',
                resumeChars: resumeMatch ? resumeMatch[1].trim().length : 0,
                jdChars: jdMatch ? jdMatch[1].trim().length : 0,
                rulesChars: rulesMatch ? rulesMatch[1].trim().length : 0,
            };
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
            return res.end(JSON.stringify(data));
        } catch (e) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: '默认测试用例文件未找到' }));
        }
    }

    if (req.method === 'POST' && req.url === '/api/generate') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                JSON.parse(body);
                proxyGenerate(body, res);
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/api/parse') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { resume, rules, model, thinking, temperature, max_tokens } = JSON.parse(body);
                if (!resume || !rules) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: '简历内容和解析规则不能为空' }));
                }
                const messages = [
                    { role: 'system', content: '你是一位专业的简历解析专家，擅长从简历中提取结构化信息。请严格按照用户提供的解析规则对简历进行解析。' },
                    { role: 'user', content: '=== 候选人简历 ===\n' + resume + '\n\n=== 解析规则 ===\n' + rules }
                ];
                streamChatCompletion(messages, { model, thinking, temperature, max_tokens }, res);
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/api/chat') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { messages, thinking, temperature, max_tokens } = JSON.parse(body);
                chatWithVLLM(messages, { thinking, temperature, max_tokens }, res);
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ========== 多轮打分 API ==========
    if (req.method === 'POST' && req.url === '/api/score-multi-round') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { jdText, resumeText, rules, targetCompanies, thinking, temperature, max_tokens } = JSON.parse(body);
                if (!jdText || !resumeText) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'jdText 和 resumeText 不能为空' }));
                }

                // SSE headers
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });

                function sendEvent(event, data) {
                    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
                }

                function callModelNonStream(sysPrompt, userPrompt, maxTok) {
                    return new Promise((resolve, reject) => {
                        // maxTok 为该轮的精准上限（已含20%预留），用户传入的 max_tokens 优先
                        const roundCap = maxTok || 2048;
                        const payload = {
                            model: MODEL,
                            messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }],
                            stream: false,
                            max_tokens: Math.min(max_tokens || roundCap, roundCap),
                            temperature: (typeof temperature === 'number') ? temperature : 0,
                            frequency_penalty: 0.3,  // 防止重复循环（如 "车载娱乐系统" 重复几十次）
                            chat_template_kwargs: { enable_thinking: false },
                        };
                        if (payload.temperature === 0) payload.seed = 42;
                        const payloadStr = JSON.stringify(payload);
                        const url = new URL(VLLM_BASE + '/v1/chat/completions');
                        const llmReq = http.request({
                            hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payloadStr) }
                        }, (llmRes) => {
                            let d = '';
                            llmRes.on('data', c => d += c);
                            llmRes.on('end', () => {
                                try {
                                    const j = JSON.parse(d);
                                    resolve((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
                                } catch(e) { reject(new Error('Parse error')); }
                            });
                        });
                        llmReq.on('error', reject);
                        llmReq.write(payloadStr);
                        llmReq.end();
                    });
                }

                function extractJSON(text) {
                    // 去除思考标签
                    var cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                    // 尝试从```json```代码块中提取
                    var codeBlock = cleaned.match(/```json\s*([\s\S]*?)```/);
                    if (codeBlock) { try { return JSON.parse(codeBlock[1].trim()); } catch(e) {} }
                    // 尝试匹配最后一个完整JSON对象
                    var matches = cleaned.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
                    if (matches && matches.length) {
                        for (var i = matches.length - 1; i >= 0; i--) {
                            try { return JSON.parse(matches[i]); } catch(e) {}
                        }
                    }
                    // 兜底：贪婪匹配
                    var m = cleaned.match(/\{[\s\S]*\}/);
                    if (m) try { return JSON.parse(m[0]); } catch(e) {}
                    return null;
                }

                const SYS1 = '你是简历信息提取专家。输出紧凑JSON（无空格无换行），不要额外文字。\n\n提取要点：\n- 行业：从公司业务/产品领域推断（汽车/半导体/互联网/金融等）\n- mainProduct：最近工作的核心产品/系统名称（非公司名），20字内\n- mainProductDetail：1句话描述产品做什么+核心技术，50字内\n- mainFunction：核心职能方向（如"大模型开发""嵌入式开发"），非职位Title，15字内\n- mainFunctionDetail：职能工作内容+技术栈，50字内\n- otherProducts：历史其他产品线，最多5个，每个20字内，不重复\n- 无法确定填"未知"\n\nJSON格式：{"industry":"","mainProduct":"","mainProductDetail":"","otherProducts":[],"mainFunction":"","mainFunctionDetail":"","totalYears":0,"age":0,"latestCompany":"","latestPosition":"","education":"","school":"","jobCount":0,"avgTenure":0,"hasGap":false,"spcMention":false,"workLocation":"","willingToRelocate":false}';

                const SYS2_BASE = '你是产品匹配判断专家。\n' +
                    '【产品方向边界】\n' +
                    '- 同一大方向（汽车域内）：三电/电驱/电控/电源/车载电子；机器人域：本体/控制器/伺服/减速器；半导体域：前道/后道/封测\n' +
                    '- 不同方向（必判 Mismatch）：底盘≠三电、自动驾驶≠通用软件、汽车电子≠消费电子、工业电源≠车载电源\n' +
                    '- 仅提及产品名而无对应工作内容 → 视为不匹配；候选人任职 JD 目标公司+职位完全对应时可适度放宽推理\n' +
                    '- 禁止仅靠关键词判定匹配；可结合公司业务/客户/供应商合理推断，但不得超出合理范围\n' +
                    '【主线规则】非主线经历（篇幅<50% 或非核心职责或近 3 年时长<60%）最高计 10 分；边缘经历（占比<20% 或辅助角色）计 0 分\n' +
                    '【对照表使用】候选人产品名可能与 JD 不同（别名/同义词），参考下方对照表模糊匹配\n' +
                    '\n评分：产品主线+有工作内容+行业匹配=20分；产品+工作内容+行业不匹配=10分；行业匹配+仅提及=5分；不匹配=0分\n' +
                    '多产品扣分：1条不扣；2条-5分；≥3条-10分。连续性：近1年主线不扣；新切入-5分；跨域-10分\n' +
                    '输出JSON（reasoning限20字）：{"productScore":分,"matchLevel":"Match/Partial/Mismatch","reasoning":"简短依据","multiProductDeduct":扣分,"continuityDeduct":扣分}';

                const SYS3_BASE = '你是职能匹配判断专家。\n' +
                    '【职能分类边界（跨大类必判 Mismatch）】\n' +
                    '- 研发类：软件/硬件/系统/测试/仿真/算法/机械结构\n' +
                    '- To C 营销类：区域销售/渠道管理/产品规划/产品营销/用户运营\n' +
                    '- 职能类：HR/财务/行政（单独分类，不与研发、营销混淆）\n' +
                    '- 研发内部细分错配（如硬件≠软件、测试≠算法）最高计 10 分（Partial）\n' +
                    '【主线规则】满足任意 2 条即为主线：①篇幅占比≥50% ②岗位职责为核心主导（非辅助/配合）③持续时间占近 3 年≥60%\n' +
                    '约束：非主线经历不得标 Match，最高 10 分；边缘经历（占比<20% 或辅助角色）计 0 分\n' +
                    '【对照表使用】候选人职能可能与 JD 名称不同，参考下方对照表判断是否为相邻职能\n' +
                    '\n评分：主线职能完全匹配=20分；相邻职能=10分；次要参与=5分；边缘/无关=0分\n' +
                    '输出JSON（reasoning限20字）：{"functionScore":分,"matchLevel":"Match/Partial/Mismatch","reasoning":"简短依据"}';

                // Step 4: 逐项对比JD要求与候选人信息
                const SYS4 = '你是简历评估助手。下面给你JD的每条硬性要求和候选人的对应信息，请逐条对比判断是否满足。\n\n' +
                    '规则：\n' +
                    '- 工作年限：看候选人实际工作年限是否在JD要求范围内\n' +
                    '- 年龄：看候选人年龄是否在JD要求范围内\n' +
                    '- 学历：本科<硕士<博士，高于要求算满足\n' +
                    '- 跳槽频率：看候选人近5年工作段数是否超过JD上限\n' +
                    '- 目标公司：看候选人当前公司是否在JD目标公司列表中（模糊匹配）\n' +
                    '- 工作地点：只要候选人意向城市中包含JD要求的任一城市即算满足\n' +
                    '- 产品/职能：参考已评估结果，Match即满足\n\n' +
                    '输出严格JSON（每条item只需name+met，不要输出jd和candidate）：\n' +
                    '{"items":[{"name":"项目名","met":true/false},...],' +
                    '"continuityScore":10或5或0,"educationScore":10或5或0,' +
                    '"preferMet":"all/partial/none",' +
                    '"jobHoppingStability":"stable/normal/unstable"}';

                (async () => {
                    // 预加载语义对照数据
                    sendEvent('step', { step: 0, name: '加载语义对照表', status: 'running' });
                    var productMapping = semanticCache.product;
                    var funcMapping = semanticCache.function;
                    var levelMapping = semanticCache.level;
                    var SYS2 = SYS2_BASE;
                    if (semanticCache.product) SYS2 += '\n\n【产品名对照表（JD产品名 → 别名/同义词）】\n' + semanticCache.product;
                    var SYS3 = SYS3_BASE;
                    if (semanticCache.function) SYS3 += '\n\n【职能对照表（JD职能名 → 相邻职能）】\n' + semanticCache.function;
                    sendEvent('step', { step: 0, name: '加载语义对照表', status: 'done' });

                    // Round 1
                    sendEvent('step', { step: 1, name: '简历信息提取', status: 'running' });
                    const r1 = await callModelNonStream(SYS1, '提取简历信息：\n\n' + resumeText, 600);
                    const info = extractJSON(r1);
                    sendEvent('step', { step: 1, name: '简历信息提取', status: 'done', result: info });

                    // Round 2
                    sendEvent('step', { step: 2, name: '产品匹配判断', status: 'running' });
                    var jdDuty = (jdText.match(/工作职责[：:]\s*([\s\S]*?)(?=\n\S|原始要求|【|$)/) || [])[1] || '';
                    var jdRawReq = (jdText.match(/原始要求[：:]\s*([\s\S]*?)(?=\n\S|【|$)/) || [])[1] || '';
                    var otherProds = (info?.otherProducts || []).join('、');
                    const r2Input = 'JD产品：' + (jdText.match(/产品[：:]\s*(.+)/)?.[1] || '未知') + '\nJD行业：' + (jdText.match(/行业[：:]\s*(.+)/)?.[1] || '未知') + '\nJD目标公司：' + (targetCompanies || '无') + '\nJD工作职责：' + (jdDuty || '无') + '\nJD原始要求：' + (jdRawReq || '无') + '\n\n【候选人提取信息】\n行业=' + (info?.industry || '') + '\n主线产品=' + (info?.mainProduct || '') + '\n工作内容=' + (info?.mainProductDetail || '') + '\n其他产品=' + (otherProds || '无') + '\n最近公司=' + (info?.latestCompany || '') + '\n最近职位=' + (info?.latestPosition || '') + '\n\n【候选人原始简历（参考，以提取信息为准）】\n' + (resumeText || '').substring(0, 2000);
                    const r2 = await callModelNonStream(SYS2, r2Input, 360);
                    const prod = extractJSON(r2);
                    sendEvent('step', { step: 2, name: '产品匹配判断', status: 'done', result: prod });

                    // Round 3
                    sendEvent('step', { step: 3, name: '职能匹配判断', status: 'running' });
                    const r3Input = 'JD职位：' + (jdText.match(/职位名称[：:]\s*(.+)/)?.[1] || '未知') + '\nJD职责：' + (jdText.match(/工作职责[：:]\s*(.+)/)?.[1] || '未知') + '\n\n【候选人提取信息】\n职能=' + (info?.mainFunction || '') + '\n职能内容=' + (info?.mainFunctionDetail || '') + '\n职位=' + (info?.latestPosition || '') + '\n\n【候选人原始简历（参考，以提取信息为准）】\n' + (resumeText || '').substring(0, 2000);
                    const r3 = await callModelNonStream(SYS3, r3Input, 360);
                    const func = extractJSON(r3);
                    sendEvent('step', { step: 3, name: '职能匹配判断', status: 'done', result: func });

                    // Round 4 - 逐项对比JD要求与候选人信息
                    sendEvent('step', { step: 4, name: '最终评分计算', status: 'running' });

                    // 从JD中提取各要求字段
                    var jdIndustry = (jdText.match(/行业[：:]\s*(.+)/) || [])[1] || '';
                    var jdProduct = (jdText.match(/产品[：:]\s*(.+)/) || [])[1] || '';
                    var jdMinExp = (jdText.match(/最低工作年限[：:]\s*(\d+)/) || [])[1] || '';
                    var jdMaxExp = (jdText.match(/最高工作年限[：:]\s*(\d+)/) || [])[1] || '';
                    var jdMinAge = (jdText.match(/最小年龄[：:]\s*(\d+)/) || [])[1] || '';
                    var jdMaxAge = (jdText.match(/最大年龄[：:]\s*(\d+)/) || [])[1] || '';
                    var jdEdu = (jdText.match(/学历要求[：:]\s*(.+)/) || [])[1] || '';
                    var jdHopping = (jdText.match(/跳槽频率[：:]\s*(.+)/) || [])[1] || '';
                    var jdLocation = (jdText.match(/工作(?:城市|地点)[：:]\s*(.+)/) || [])[1] || '';
                    var jdTitle = (jdText.match(/职位名称[：:]\s*(.+)/) || [])[1] || '';
                    var jdRank = (jdText.match(/职级[：:]\s*(.+)/) || [])[1] || '';

                    // 逐条列出对比
                    var r4Input = '请逐条对比以下JD要求与候选人信息，判断每条是否满足：\n\n';
                    r4Input += '【JD硬性要求 vs 候选人信息】\n';
                    r4Input += '1. 行业：JD要求="' + jdIndustry + '" | 候选人行业="' + (info?.industry || '') + '"\n';
                    r4Input += '2. 产品：JD要求="' + jdProduct + '" | 候选人主线产品="' + (info?.mainProduct || '') + '"\n';
                    r4Input += '3. 工作年限：JD要求=' + jdMinExp + '-' + jdMaxExp + '年 | 候选人=' + (info?.totalYears || '') + '年\n';
                    r4Input += '4. 年龄：JD要求=' + jdMinAge + '-' + jdMaxAge + '岁 | 候选人=' + (info?.age || '') + '岁\n';
                    r4Input += '5. 学历：JD要求="' + jdEdu + '" | 候选人="' + (info?.education || '') + '"\n';
                    r4Input += '6. 职级：JD要求="' + jdRank + '" | 候选人职级="' + (info?.latestPosition || '') + '"\n';
                    if (levelMapping) r4Input += '   （职级对照参考：\n' + levelMapping + '\n   ）\n';
                    r4Input += '7. 职位：JD要求="' + jdTitle + '" | 候选人职位="' + (info?.latestPosition || '') + '"\n';
                    r4Input += '8. 跳槽频率：JD要求="' + jdHopping + '" | 候选人近5年' + (info?.jobCount || '?') + '段，平均' + (info?.avgTenure || '?') + '年/段\n';
                    r4Input += '9. 工作地点：JD要求="' + jdLocation + '" | 候选人="' + (info?.workLocation || '') + '"\n';
                    r4Input += '10. 目标公司：JD目标公司="' + (targetCompanies || '无') + '" | 候选人当前公司="' + (info?.latestCompany || '') + '"\n';
                    r4Input += '11. SPC技能：JD要求有SPC | 候选人=' + (info?.spcMention ? '有' : '未提及') + '\n';

                    r4Input += '\n【已评估维度】\n';
                    r4Input += '产品匹配=' + (prod?.productScore || 0) + '分(' + (prod?.matchLevel || '?') + ') ' + (prod?.reasoning || '') + '\n';
                    r4Input += '职能匹配=' + (func?.functionScore || 0) + '分(' + (func?.matchLevel || '?') + ') ' + (func?.reasoning || '') + '\n';

                    r4Input += '\n请逐条判断每项是否满足(met=true/false)，输出JSON。';

                    const r4 = await callModelNonStream(SYS4, r4Input, 720);
                    const dim = extractJSON(r4);
                    console.log('[DEBUG SYS4 raw items]', JSON.stringify(dim?.items?.map(function(i){return i.name;})));

                    // === 代码计算最终总分 ===
                    var productScore = prod?.productScore || 0;
                    var functionScore = func?.functionScore || 0;
                    var continuityScore = dim?.continuityScore || 0;
                    var educationScore = dim?.educationScore || 0;
                    var baseScore = productScore + functionScore + continuityScore + educationScore;

                    // 从items数组计算Must满足率，用代码覆盖关键项
                    var items = dim?.items || [];

                    // 工作地点：候选人的意向地点包含JD城市即满足，或者愿意relocate也算
                    var jdCities = jdLocation.split(/[\/、,，\s]+/).filter(Boolean);
                    var candCities = (info?.workLocation || '').split(/[\/、,，\s]+/).filter(Boolean);
                    var locationMet = jdCities.some(function(jc) {
                        return candCities.some(function(cc) {
                            return cc.indexOf(jc) >= 0 || jc.indexOf(cc) >= 0;
                        });
                    });
                    if (!locationMet && (info?.willingToRelocate === true || info?.willingToRelocate === '是')) {
                        locationMet = true;
                    }

                    // 代码级目标公司匹配：模糊包含
                    var targetList = (targetCompanies || '').replace(/^\[|\]$/g, '').trim().split(/[、,，\s]+/).filter(Boolean);
                    var candCompany = info?.latestCompany || '';
                    var targetMet = targetList.some(function(tc) {
                        return candCompany.indexOf(tc) >= 0 || tc.indexOf(candCompany) >= 0;
                    });

                    // 代码级工作年限匹配
                    var expYears = parseFloat(info?.totalYears) || 0;
                    var minExp = parseFloat(jdMinExp) || 0;
                    var maxExp = parseFloat(jdMaxExp) || 99;
                    var expMet = expYears >= minExp && expYears <= maxExp;
                    // 工作年限严重不达标：阶梯处罚
                    var expGap = minExp - expYears;
                    var expPenalty = 0;  // 额外扣分
                    if (!expMet && expGap > 0) {
                        if (expGap >= 3) {
                            expPenalty = 20;  // 差距≥3年：严重不达标
                        } else if (expGap >= 1) {
                            expPenalty = 10;  // 差距1-3年：明显不足
                        } else {
                            expPenalty = 3;   // 差距<1年：轻微
                        }
                    }

                    // 代码级年龄匹配
                    var age = parseFloat(info?.age) || 0;
                    var minAge = parseFloat(jdMinAge) || 0;
                    var maxAge = parseFloat(jdMaxAge) || 99;
                    var ageMet = age >= minAge && age <= maxAge;

                    // 代码级学历匹配
                    var eduMap = {'高中':1,'中专':1,'大专':2,'专科':2,'本科':3,'硕士':4,'博士':5};
                    var jdEduLevel = eduMap[jdEdu] || 3;
                    var candEduLevel = 0;
                    for (var ek in eduMap) {
                        if ((info?.education || '').indexOf(ek) >= 0) candEduLevel = Math.max(candEduLevel, eduMap[ek]);
                    }
                    var eduMet = candEduLevel >= jdEduLevel;
                    console.log('[DEBUG match] loc=' + locationMet + ' target=' + targetMet + ' exp=' + expMet + ' age=' + ageMet + ' edu=' + eduMet);

                    // 代码级职级匹配（语义对照表）
                    // 职级档次: 初级=1, 中级(工程师)=2, 高级=3, 专家/主管=4, 经理=5, 高级经理=6, 总监=7, 总经理/VP=8, 总裁=9
                    var rankLevels = {
                        '初级':1, '初级工程师':1, '助理工程师':1, 'Junior':1,
                        '工程师':2, 'Engineer':2,
                        '高级工程师':3, 'Senior Engineer':3, 'Sr Engineer':3,
                        '资深工程师':4, 'Staff Engineer':4,
                        '主管':4, 'Supervisor':4, 'Team Lead':4,
                        '专家':5, 'Expert':5,
                        '经理':5, 'Manager':5,
                        '高级经理':6, 'Senior Manager':6,
                        '副总监':6, 'Associate Director':6,
                        '总监':7, 'Director':7,
                        '高级总监':8, 'Senior Director':8,
                        '总经理':8, 'GM':8, 'General Manager':8,
                        '副总裁':9, 'VP':9, 'Vice President':9,
                        '总裁':10, 'President':10
                    };
                    // 从语义对照表补充职级映射
                    if (semanticCache.level) {
                        var lvLines = semanticCache.level.split('\n');
                        lvLines.forEach(function(line) {
                            var parts = line.split(' → ');
                            var key = parts[0];
                            var vals = (parts[1] || '').split('、');
                            // 确保 key_name 有档位
                            if (!rankLevels[key]) rankLevels[key] = 3; // 默认高级
                            vals.forEach(function(v) { if (v && !rankLevels[v]) rankLevels[v] = rankLevels[key]; });
                        });
                    }

                    function getLevelRank(text) {
                        if (!text) return 0;
                        var best = 0;
                        for (var lk in rankLevels) {
                            if (text.indexOf(lk) >= 0 && rankLevels[lk] > best) {
                                best = rankLevels[lk];
                            }
                        }
                        return best;
                    }

                    var jdRankLevel = getLevelRank((jdRank || '') + (jdTitle || ''));
                    var candRankLevel = getLevelRank((info?.latestPosition || '') + (info?.mainFunction || ''));
                    // 职级匹配：候选人 ≥ JD要求，或双方都无要求
                    var rankMet = jdRankLevel === 0 || candRankLevel >= jdRankLevel;
                    console.log('[DEBUG rank] jdRankLevel=' + jdRankLevel + ' candRankLevel=' + candRankLevel + ' met=' + rankMet);
                    console.log('[DEBUG targetList]', targetCompanies, '| candCompany=', candCompany);

                    // 目标公司无要求时不算缺失
                    var hasTargetList = targetList.length > 0;
                    if (!hasTargetList) targetMet = true;

                    // 代码级产品匹配兜底：目标公司+职能Match → 产品例外计20分
                    if (targetMet && func?.matchLevel === 'Match') {
                        prod.matchLevel = 'Match';
                        prod.productScore = Math.max(prod?.productScore || 0, 20);
                        console.log('[DEBUG product override] target+func match → product=Match/20');
                    }

                    // 职能Match时职位也按匹配算（语义等价，不扣字面Title）
                    var positionMetViaFunc = func?.matchLevel === 'Match';

                    // 跳槽频率：JD没要求时不算缺失
                    var hasHoppingReq = jdHopping && jdHopping.trim();

                    // 覆盖items中的关键项
                    items = items.map(function(it) {
                        if (it.name === '行业') it.met = (prod?.matchLevel !== 'Mismatch');
                        if (it.name === '产品') it.met = (prod?.matchLevel === 'Match');
                        if (it.name === '工作地点') { it.met = locationMet; it.jd = jdLocation; it.candidate = info?.workLocation || ''; }
                        if (it.name === '目标公司') { it.met = targetMet; it.jd = targetCompanies || '无要求'; it.candidate = candCompany; }
                        if (it.name === '工作年限') { it.met = expMet; it.jd = jdMinExp + '-' + jdMaxExp + '年'; it.candidate = expYears + '年'; }
                        if (it.name === '年龄') { it.met = ageMet; it.jd = jdMinAge + '-' + jdMaxAge + '岁'; it.candidate = age + '岁'; }
                        if (it.name === '学历') { it.met = eduMet; it.jd = jdEdu; it.candidate = info?.education || ''; }
                        if (it.name === '职位') { if (positionMetViaFunc) it.met = true; }
                        if (it.name === '职级') { if (rankMet) it.met = true; }
                        if (it.name === '跳槽频率') { if (!hasHoppingReq) it.met = true; }
                        return it;
                    });
                    console.log('[DEBUG items after override]', JSON.stringify(items.map(function(i){return {n:i.name, m:i.met};})));
                    var metCount = items.filter(function(it) { return it.met === true; }).length;
                    var totalCount = items.length || 1;
                    var mustPct = totalCount > 0 ? Math.round(metCount * 100 / totalCount) : 0;

                    // 从items中提取缺失项
                    var missingItems = items.filter(function(it) { return it.met === false; }).map(function(it) { return it.name; });

                    // Gate判定：产品+职能主线
                    // 强Gate规则（scoring_rules v3.0 第2条）：产品/职能任一 Mismatch → 直接 Mismatch 封顶30
                    var prodMatch = (prod?.matchLevel === 'Match');
                    var funcMatch = (func?.matchLevel === 'Match');
                    var prodMismatch = (prod?.matchLevel === 'Mismatch');
                    var funcMismatch = (func?.matchLevel === 'Mismatch');
                    var gatePath = 'Match';
                    if (prodMismatch || funcMismatch || mustPct < 30) {
                        gatePath = 'Mismatch';
                    } else if (mustPct < 60 || !prodMatch || !funcMatch) {
                        gatePath = 'Partial';
                    }
                    // 工作年限严重不达标（差距≥3年）：强制降级到Partial
                    if (expPenalty >= 20 && gatePath === 'Match') {
                        gatePath = 'Partial';
                    }

                    // Must缺失扣分（仅Match/Partial路径）：每缺1条扣3分（scoring_rules v3.0 第3条）
                    var deductScore = 0;
                    if (gatePath !== 'Mismatch') {
                        deductScore = missingItems.length * 3;
                    }

                    // 加分项（用代码级匹配结果）
                    var bonusScore = 0;
                    // 目标公司：匹配+20，无要求+10（不扣候选人的分）
                    if (targetMet && hasTargetList) bonusScore += 20;
                    else if (targetMet && !hasTargetList) bonusScore += 10;

                    var prefer = dim?.preferMet || 'none';
                    if (prefer === 'all') bonusScore += 10;
                    else if (prefer === 'partial') bonusScore += 5;

                    var hop = dim?.jobHoppingStability || 'normal';
                    if (hop === 'stable') bonusScore += 5;
                    else if (hop === 'normal') bonusScore += 2;

                    // 产品+职能双Match核心能力奖励
                    if (prodMatch && funcMatch) bonusScore += 5;

                    // 地点：代码级判断
                    if (locationMet) bonusScore += 5;

                    // 总分（含工作年限阶梯处罚）
                    var finalScore = baseScore + bonusScore - deductScore - expPenalty;
                    if (gatePath === 'Partial') finalScore = Math.min(finalScore, 59);
                    if (gatePath === 'Mismatch') finalScore = Math.min(finalScore, 30);
                    // Must有缺失时封顶（硬性要求不满足不能满分）
                    if (missingItems.length >= 3) finalScore = Math.min(finalScore, 79);
                    else if (missingItems.length >= 1) finalScore = Math.min(finalScore, 95);
                    finalScore = Math.max(0, Math.min(100, finalScore));

                    // 推荐等级
                    var overallRecommendation = '不需要联系';
                    if (finalScore >= 80) overallRecommendation = '强烈推荐';
                    else if (finalScore >= 60) overallRecommendation = '推荐';
                    else if (finalScore >= 50) overallRecommendation = '需电话确认';
                    else if (finalScore >= 40) overallRecommendation = '需人工查看';
                    else if (finalScore >= 20) overallRecommendation = '不建议联系';

                    // === 生成原因列表（代码主导，结合LLM补充） ===
                    var reasons = [];
                    var jdProductStr = jdProduct || '未知';
                    var jdTitleStr = jdTitle || '未知';
                    var candProductStr = info?.mainProduct || '未知';
                    var candFuncStr = info?.mainFunction || '未知';
                    var candCompanyStr = info?.latestCompany || '';
                    var candFuncDetail = info?.mainFunctionDetail || '';

                    // 核心：产品+职能匹配判断
                    var prodOk = prod?.matchLevel === 'Match';
                    var funcOk = func?.matchLevel === 'Match';

                    if (gatePath === 'Mismatch') {
                        // 一票否决原因
                        if (!prodOk) {
                            var prodReason = '产品主线为' + candProductStr;
                            if (candCompanyStr) prodReason += '（' + candCompanyStr + '）';
                            prodReason += '，JD要求' + jdProductStr + '，两者属不同产品方向';
                            if (candProductStr !== '未知' && jdProductStr !== '未知') {
                                prodReason += '（' + candProductStr + '≠' + jdProductStr + '）';
                            }
                            reasons.push(prodReason);
                        }
                        if (!funcOk) {
                            var funcReason = '职能主线为' + candFuncStr;
                            if (candFuncDetail) funcReason += '（' + candFuncDetail.substring(0, 50) + '）';
                            funcReason += '，JD要求' + jdTitleStr + '，职能领域不匹配';
                            reasons.push(funcReason);
                        }
                        if (!prodOk && !funcOk) {
                            reasons.push('产品+职能主线均不匹配，触发强Gate一票否决规则');
                        } else {
                            reasons.push('Must满足率仅' + mustPct + '%，触发Mismatch封顶规则');
                        }
                        if (!expMet) {
                            reasons.push('工作年限严重不达标：JD要求' + minExp + '年，候选人仅' + expYears + '年（差距' + expGap + '年）');
                        }
                    } else if (gatePath === 'Partial') {
                        if (prodOk && !funcOk) {
                            reasons.push('产品匹配（' + candProductStr + '=' + jdProductStr + '），但职能仅部分匹配');
                            reasons.push('职能主线为' + candFuncStr + '，与JD要求' + jdTitleStr + '不完全一致');
                        } else if (!prodOk && funcOk) {
                            reasons.push('职能匹配，但产品仅部分匹配（候选人' + candProductStr + '，JD要求' + jdProductStr + '）');
                        } else {
                            reasons.push('产品+职能均为部分匹配，进入Partial路径');
                        }
                        if (missingItems.length > 0) {
                            reasons.push('关键缺失项：' + missingItems.slice(0, 3).join('、'));
                        }
                        if (!expMet) {
                            reasons.push('工作年限严重不达标：JD要求' + minExp + '年，候选人仅' + expYears + '年（差距' + expGap + '年），扣' + expPenalty + '分');
                        }
                    } else {
                        // Match路径
                        if (prodOk) {
                            if (candProductStr !== '未知') {
                                reasons.push('产品匹配：候选人' + candProductStr + '方向与JD要求的' + jdProductStr + '一致');
                            } else if (prod?.reasoning) {
                                reasons.push('产品匹配：' + prod.reasoning);
                            } else {
                                reasons.push('产品匹配：与JD要求的' + jdProductStr + '一致');
                            }
                        }
                        if (funcOk && candFuncDetail) {
                            reasons.push('职能匹配：候选人' + candFuncDetail.substring(0, 60) + '，直接匹配JD' + jdTitleStr + '岗位要求');
                        } else if (funcOk) {
                            reasons.push('职能匹配：候选人' + candFuncStr + '经验与JD' + jdTitleStr + '岗位一致');
                        }
                        // 补充项
                        if (targetMet && hasTargetList) reasons.push('目标公司匹配：候选人当前在' + candCompanyStr + '任职');
                        if (!expMet) {
                            reasons.push('工作年限严重不达标：JD要求' + minExp + '年，候选人仅' + expYears + '年（差距' + (minExp - expYears) + '年），扣' + expPenalty + '分');
                        }
                        if (missingItems.length > 0) {
                            reasons.push('不满足项：' + missingItems.join('、'));
                        }
                    }

                    // 最后：如果LLM也有reasons，且代码生成的不够，补充LLM的
                    if (dim?.reasons && Array.isArray(dim.reasons)) {
                        var llmReasons = dim.reasons.filter(function(r) { return r && r.trim(); });
                        if (reasons.length < 2 && llmReasons.length > 0) {
                            reasons = reasons.concat(llmReasons.slice(0, 3));
                        }
                    }

                    var final = {
                        finalScore: finalScore,
                        baseScore: baseScore,
                        bonusScore: bonusScore,
                        deductScore: deductScore,
                        gatePath: gatePath,
                        overallRecommendation: overallRecommendation,
                        reasons: reasons,
                        detail: {
                            productScore: productScore,
                            functionScore: functionScore,
                            continuityScore: continuityScore,
                            educationScore: educationScore,
                            mustHaveMet: mustPct,
                            mustHaveMissing: missingItems,
                            items: items,
                            targetCompanyStatus: targetMet ? 'current' : 'none',
                            preferMet: prefer,
                            jobHoppingStability: hop,
                            locationMatch: locationMet ? 'exact' : 'mismatch'
                        }
                    };
                    sendEvent('step', { step: 4, name: '最终评分计算', status: 'done', result: final });

                    // 只返回打分规则要求的三个字段
                    var cleanResult = {
                        finalScore: final.finalScore,
                        reasons: final.reasons,
                        overallRecommendation: final.overallRecommendation
                    };
                    sendEvent('done', { finalScore: cleanResult });
                    res.end();
                })().catch(e => {
                    sendEvent('error', { message: e.message });
                    res.end();
                });
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/api/score-3round') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { jdText, resumeText, rules, targetCompanies, thinking, temperature, max_tokens } = JSON.parse(body);
                if (!jdText || !resumeText) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'jdText 和 resumeText 不能为空' }));
                }

                // SSE headers
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });

                function sendEvent(event, data) {
                    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
                }

                function callModelNonStream(sysPrompt, userPrompt, maxTok) {
                    return new Promise((resolve, reject) => {
                        // maxTok 为该轮的精准上限（已含20%预留），用户传入的 max_tokens 优先
                        const roundCap = maxTok || 2048;
                        const payload = {
                            model: MODEL,
                            messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }],
                            stream: false,
                            max_tokens: Math.min(max_tokens || roundCap, roundCap),
                            temperature: (typeof temperature === 'number') ? temperature : 0,
                            frequency_penalty: 0.3,  // 防止重复循环（如 "车载娱乐系统" 重复几十次）
                            chat_template_kwargs: { enable_thinking: false },
                        };
                        if (payload.temperature === 0) payload.seed = 42;
                        const payloadStr = JSON.stringify(payload);
                        const url = new URL(VLLM_BASE + '/v1/chat/completions');
                        const llmReq = http.request({
                            hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payloadStr) }
                        }, (llmRes) => {
                            let d = '';
                            llmRes.on('data', c => d += c);
                            llmRes.on('end', () => {
                                try {
                                    const j = JSON.parse(d);
                                    resolve((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
                                } catch(e) { reject(new Error('Parse error')); }
                            });
                        });
                        llmReq.on('error', reject);
                        llmReq.write(payloadStr);
                        llmReq.end();
                    });
                }

                function extractJSON(text) {
                    // 去除思考标签
                    var cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                    // 尝试从```json```代码块中提取
                    var codeBlock = cleaned.match(/```json\s*([\s\S]*?)```/);
                    if (codeBlock) { try { return JSON.parse(codeBlock[1].trim()); } catch(e) {} }
                    // 尝试匹配最后一个完整JSON对象
                    var matches = cleaned.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
                    if (matches && matches.length) {
                        for (var i = matches.length - 1; i >= 0; i--) {
                            try { return JSON.parse(matches[i]); } catch(e) {}
                        }
                    }
                    // 兜底：贪婪匹配
                    var m = cleaned.match(/\{[\s\S]*\}/);
                    if (m) try { return JSON.parse(m[0]); } catch(e) {}
                    return null;
                }

                const SYS1 = '你是简历信息提取专家。输出紧凑JSON（无空格无换行），不要额外文字。\n\n提取要点：\n- 行业：从公司业务/产品领域推断（汽车/半导体/互联网/金融等）\n- mainProduct：最近工作的核心产品/系统名称（非公司名），20字内\n- mainProductDetail：1句话描述产品做什么+核心技术，50字内\n- mainFunction：核心职能方向（如"大模型开发""嵌入式开发"），非职位Title，15字内\n- mainFunctionDetail：职能工作内容+技术栈，50字内\n- otherProducts：历史其他产品线，最多5个，每个20字内，不重复\n- 无法确定填"未知"\n\nJSON格式：{"industry":"","mainProduct":"","mainProductDetail":"","otherProducts":[],"mainFunction":"","mainFunctionDetail":"","totalYears":0,"age":0,"latestCompany":"","latestPosition":"","education":"","school":"","jobCount":0,"avgTenure":0,"hasGap":false,"spcMention":false,"workLocation":"","willingToRelocate":false}';

                const SYS2_BASE = '你是产品匹配判断专家。\n' +
                    '【产品方向边界】\n' +
                    '- 同一大方向（汽车域内）：三电/电驱/电控/电源/车载电子；机器人域：本体/控制器/伺服/减速器；半导体域：前道/后道/封测\n' +
                    '- 不同方向（必判 Mismatch）：底盘≠三电、自动驾驶≠通用软件、汽车电子≠消费电子、工业电源≠车载电源\n' +
                    '- 仅提及产品名而无对应工作内容 → 视为不匹配；候选人任职 JD 目标公司+职位完全对应时可适度放宽推理\n' +
                    '- 禁止仅靠关键词判定匹配；可结合公司业务/客户/供应商合理推断，但不得超出合理范围\n' +
                    '【主线规则】非主线经历（篇幅<50% 或非核心职责或近 3 年时长<60%）最高计 10 分；边缘经历（占比<20% 或辅助角色）计 0 分\n' +
                    '【对照表使用】候选人产品名可能与 JD 不同（别名/同义词），参考下方对照表模糊匹配\n' +
                    '\n评分：产品主线+有工作内容+行业匹配=20分；产品+工作内容+行业不匹配=10分；行业匹配+仅提及=5分；不匹配=0分\n' +
                    '多产品扣分：1条不扣；2条-5分；≥3条-10分。连续性：近1年主线不扣；新切入-5分；跨域-10分\n' +
                    '输出JSON（reasoning限20字）：{"productScore":分,"matchLevel":"Match/Partial/Mismatch","reasoning":"简短依据","multiProductDeduct":扣分,"continuityDeduct":扣分}';

                const SYS3_BASE = '你是职能匹配判断专家。\n' +
                    '【职能分类边界（跨大类必判 Mismatch）】\n' +
                    '- 研发类：软件/硬件/系统/测试/仿真/算法/机械结构\n' +
                    '- To C 营销类：区域销售/渠道管理/产品规划/产品营销/用户运营\n' +
                    '- 职能类：HR/财务/行政（单独分类，不与研发、营销混淆）\n' +
                    '- 研发内部细分错配（如硬件≠软件、测试≠算法）最高计 10 分（Partial）\n' +
                    '【主线规则】满足任意 2 条即为主线：①篇幅占比≥50% ②岗位职责为核心主导（非辅助/配合）③持续时间占近 3 年≥60%\n' +
                    '约束：非主线经历不得标 Match，最高 10 分；边缘经历（占比<20% 或辅助角色）计 0 分\n' +
                    '【对照表使用】候选人职能可能与 JD 名称不同，参考下方对照表判断是否为相邻职能\n' +
                    '\n评分：主线职能完全匹配=20分；相邻职能=10分；次要参与=5分；边缘/无关=0分\n' +
                    '输出JSON（reasoning限20字）：{"functionScore":分,"matchLevel":"Match/Partial/Mismatch","reasoning":"简短依据"}';

                // Step 4: 逐项对比JD要求与候选人信息
                const SYS4 = '你是简历评估助手。下面给你JD的每条硬性要求和候选人的对应信息，请逐条对比判断是否满足。\n\n' +
                    '规则：\n' +
                    '- 工作年限：看候选人实际工作年限是否在JD要求范围内\n' +
                    '- 年龄：看候选人年龄是否在JD要求范围内\n' +
                    '- 学历：本科<硕士<博士，高于要求算满足\n' +
                    '- 跳槽频率：看候选人近5年工作段数是否超过JD上限\n' +
                    '- 目标公司：看候选人当前公司是否在JD目标公司列表中（模糊匹配）\n' +
                    '- 工作地点：只要候选人意向城市中包含JD要求的任一城市即算满足\n' +
                    '- 产品/职能：参考已评估结果，Match即满足\n\n' +
                    '输出严格JSON（每条item只需name+met，不要输出jd和candidate）：\n' +
                    '{"items":[{"name":"项目名","met":true/false},...],' +
                    '"continuityScore":10或5或0,"educationScore":10或5或0,' +
                    '"preferMet":"all/partial/none",' +
                    '"jobHoppingStability":"stable/normal/unstable"}';

                (async () => {
                    // 预加载语义对照数据
                    sendEvent('step', { step: 0, name: '加载语义对照表', status: 'running' });
                    var productMapping = semanticCache.product;
                    var funcMapping = semanticCache.function;
                    var levelMapping = semanticCache.level;
                    var SYS2 = SYS2_BASE;
                    if (semanticCache.product) SYS2 += '\n\n【产品名对照表（JD产品名 → 别名/同义词）】\n' + semanticCache.product;
                    var SYS3 = SYS3_BASE;
                    if (semanticCache.function) SYS3 += '\n\n【职能对照表（JD职能名 → 相邻职能）】\n' + semanticCache.function;
                    sendEvent('step', { step: 0, name: '加载语义对照表', status: 'done' });

                    // Round 1
                    sendEvent('step', { step: 1, name: '简历信息提取', status: 'running' });
                    const r1 = await callModelNonStream(SYS1, '提取简历信息：\n\n' + resumeText, 600);
                    const info = extractJSON(r1);
                    sendEvent('step', { step: 1, name: '简历信息提取', status: 'done', result: info });

                    // Round 2
                    sendEvent('step', { step: 2, name: '产品匹配判断', status: 'running' });
                    var jdDuty = (jdText.match(/工作职责[：:]\s*([\s\S]*?)(?=\n\S|原始要求|【|$)/) || [])[1] || '';
                    var jdRawReq = (jdText.match(/原始要求[：:]\s*([\s\S]*?)(?=\n\S|【|$)/) || [])[1] || '';
                    var otherProds = (info?.otherProducts || []).join('、');
                    const r2Input = 'JD产品：' + (jdText.match(/产品[：:]\s*(.+)/)?.[1] || '未知') + '\nJD行业：' + (jdText.match(/行业[：:]\s*(.+)/)?.[1] || '未知') + '\nJD目标公司：' + (targetCompanies || '无') + '\nJD工作职责：' + (jdDuty || '无') + '\nJD原始要求：' + (jdRawReq || '无') + '\n\n【候选人提取信息】\n行业=' + (info?.industry || '') + '\n主线产品=' + (info?.mainProduct || '') + '\n工作内容=' + (info?.mainProductDetail || '') + '\n其他产品=' + (otherProds || '无') + '\n最近公司=' + (info?.latestCompany || '') + '\n最近职位=' + (info?.latestPosition || '') + '\n\n【候选人原始简历（参考，以提取信息为准）】\n' + (resumeText || '').substring(0, 2000);
                    const r2 = await callModelNonStream(SYS2, r2Input, 360);
                    const prod = extractJSON(r2);
                    sendEvent('step', { step: 2, name: '产品匹配判断', status: 'done', result: prod });

                    // Round 3
                    sendEvent('step', { step: 3, name: '职能匹配判断', status: 'running' });
                    const r3Input = 'JD职位：' + (jdText.match(/职位名称[：:]\s*(.+)/)?.[1] || '未知') + '\nJD职责：' + (jdText.match(/工作职责[：:]\s*(.+)/)?.[1] || '未知') + '\n\n【候选人提取信息】\n职能=' + (info?.mainFunction || '') + '\n职能内容=' + (info?.mainFunctionDetail || '') + '\n职位=' + (info?.latestPosition || '') + '\n\n【候选人原始简历（参考，以提取信息为准）】\n' + (resumeText || '').substring(0, 2000);
                    const r3 = await callModelNonStream(SYS3, r3Input, 360);
                    const func = extractJSON(r3);
                    sendEvent('step', { step: 3, name: '职能匹配判断', status: 'done', result: func });

                    // === [3轮版] R4 砍除: 4 个 meta 字段用代码兜底 ===
                    sendEvent('step', { step: 4, name: '最终评分计算', status: 'running' });

                    // 从JD中提取各要求字段 (R4 后续代码仍依赖)
                    var jdIndustry = (jdText.match(/行业[：:]\s*(.+)/) || [])[1] || '';
                    var jdProduct = (jdText.match(/产品[：:]\s*(.+)/) || [])[1] || '';
                    var jdMinExp = (jdText.match(/最低工作年限[：:]\s*(\d+)/) || [])[1] || '';
                    var jdMaxExp = (jdText.match(/最高工作年限[：:]\s*(\d+)/) || [])[1] || '';
                    var jdMinAge = (jdText.match(/最小年龄[：:]\s*(\d+)/) || [])[1] || '';
                    var jdMaxAge = (jdText.match(/最大年龄[：:]\s*(\d+)/) || [])[1] || '';
                    var jdEdu = (jdText.match(/学历要求[：:]\s*(.+)/) || [])[1] || '';
                    var jdHopping = (jdText.match(/跳槽频率[：:]\s*(.+)/) || [])[1] || '';
                    var jdLocation = (jdText.match(/工作(?:城市|地点)[：:]\s*(.+)/) || [])[1] || '';
                    var jdTitle = (jdText.match(/职位名称[：:]\s*(.+)/) || [])[1] || '';
                    var jdRank = (jdText.match(/职级[：:]\s*(.+)/) || [])[1] || '';

                    // 代码兜底生成 dim 对象 (R4 砍除, 不调 LLM)
                    var _eduStr = info?.education || '';
                    var _py_education = (_eduStr.indexOf('博') >= 0 || _eduStr.indexOf('硕') >= 0 || _eduStr.indexOf('本科') >= 0) ? 10
                                      : (_eduStr.indexOf('大专') >= 0 || _eduStr.indexOf('专科') >= 0) ? 5 : 0;
                    var _jc = parseInt(info?.jobCount) || 0;
                    var _py_continuity = (_jc === 0) ? 5 : (_jc <= 3 ? 10 : (_jc <= 5 ? 5 : 0));
                    var _at = parseFloat(info?.avgTenure) || 0;
                    var _py_stability = _at >= 2.5 ? 'stable' : (_at >= 1.5 ? 'normal' : 'unstable');
                    // preferMet: 回放分析显示 LLM 91% 都拍 partial, 保持 partial 默认值
                    var _py_prefer = 'partial';

                    // items 数组: 11 条全初始化 false, 后续 override 逻辑会按代码规则覆盖
                    const dim = {
                        items: [
                            { name: '行业',     met: false },
                            { name: '产品',     met: false },
                            { name: '工作年限', met: false },
                            { name: '年龄',     met: false },
                            { name: '学历',     met: false },
                            { name: '职级',     met: false },
                            { name: '职位',     met: false },
                            { name: '跳槽频率', met: false },
                            { name: '工作地点', met: false },
                            { name: '目标公司', met: false },
                            { name: 'SPC技能',  met: false }
                        ],
                        continuityScore: _py_continuity,
                        educationScore: _py_education,
                        preferMet: _py_prefer,
                        jobHoppingStability: _py_stability
                    };
                    console.log('[DEBUG 3round dim]', JSON.stringify({c:_py_continuity, e:_py_education, s:_py_stability, p:_py_prefer}));

                    // SPC 技能: 后续 override 没覆盖, 这里直接按 info 设
                    dim.items[10].met = !!info?.spcMention;

                    // === 代码计算最终总分 ===
                    var productScore = prod?.productScore || 0;
                    var functionScore = func?.functionScore || 0;
                    var continuityScore = dim?.continuityScore || 0;
                    var educationScore = dim?.educationScore || 0;
                    var baseScore = productScore + functionScore + continuityScore + educationScore;

                    // 从items数组计算Must满足率，用代码覆盖关键项
                    var items = dim?.items || [];

                    // 工作地点：候选人的意向地点包含JD城市即满足，或者愿意relocate也算
                    var jdCities = jdLocation.split(/[\/、,，\s]+/).filter(Boolean);
                    var candCities = (info?.workLocation || '').split(/[\/、,，\s]+/).filter(Boolean);
                    var locationMet = jdCities.some(function(jc) {
                        return candCities.some(function(cc) {
                            return cc.indexOf(jc) >= 0 || jc.indexOf(cc) >= 0;
                        });
                    });
                    if (!locationMet && (info?.willingToRelocate === true || info?.willingToRelocate === '是')) {
                        locationMet = true;
                    }

                    // 代码级目标公司匹配：模糊包含
                    var targetList = (targetCompanies || '').replace(/^\[|\]$/g, '').trim().split(/[、,，\s]+/).filter(Boolean);
                    var candCompany = info?.latestCompany || '';
                    var targetMet = targetList.some(function(tc) {
                        return candCompany.indexOf(tc) >= 0 || tc.indexOf(candCompany) >= 0;
                    });

                    // 代码级工作年限匹配
                    var expYears = parseFloat(info?.totalYears) || 0;
                    var minExp = parseFloat(jdMinExp) || 0;
                    var maxExp = parseFloat(jdMaxExp) || 99;
                    var expMet = expYears >= minExp && expYears <= maxExp;
                    // 工作年限严重不达标：阶梯处罚
                    var expGap = minExp - expYears;
                    var expPenalty = 0;  // 额外扣分
                    if (!expMet && expGap > 0) {
                        if (expGap >= 3) {
                            expPenalty = 20;  // 差距≥3年：严重不达标
                        } else if (expGap >= 1) {
                            expPenalty = 10;  // 差距1-3年：明显不足
                        } else {
                            expPenalty = 3;   // 差距<1年：轻微
                        }
                    }

                    // 代码级年龄匹配
                    var age = parseFloat(info?.age) || 0;
                    var minAge = parseFloat(jdMinAge) || 0;
                    var maxAge = parseFloat(jdMaxAge) || 99;
                    var ageMet = age >= minAge && age <= maxAge;

                    // 代码级学历匹配
                    var eduMap = {'高中':1,'中专':1,'大专':2,'专科':2,'本科':3,'硕士':4,'博士':5};
                    var jdEduLevel = eduMap[jdEdu] || 3;
                    var candEduLevel = 0;
                    for (var ek in eduMap) {
                        if ((info?.education || '').indexOf(ek) >= 0) candEduLevel = Math.max(candEduLevel, eduMap[ek]);
                    }
                    var eduMet = candEduLevel >= jdEduLevel;
                    console.log('[DEBUG match] loc=' + locationMet + ' target=' + targetMet + ' exp=' + expMet + ' age=' + ageMet + ' edu=' + eduMet);

                    // 代码级职级匹配（语义对照表）
                    // 职级档次: 初级=1, 中级(工程师)=2, 高级=3, 专家/主管=4, 经理=5, 高级经理=6, 总监=7, 总经理/VP=8, 总裁=9
                    var rankLevels = {
                        '初级':1, '初级工程师':1, '助理工程师':1, 'Junior':1,
                        '工程师':2, 'Engineer':2,
                        '高级工程师':3, 'Senior Engineer':3, 'Sr Engineer':3,
                        '资深工程师':4, 'Staff Engineer':4,
                        '主管':4, 'Supervisor':4, 'Team Lead':4,
                        '专家':5, 'Expert':5,
                        '经理':5, 'Manager':5,
                        '高级经理':6, 'Senior Manager':6,
                        '副总监':6, 'Associate Director':6,
                        '总监':7, 'Director':7,
                        '高级总监':8, 'Senior Director':8,
                        '总经理':8, 'GM':8, 'General Manager':8,
                        '副总裁':9, 'VP':9, 'Vice President':9,
                        '总裁':10, 'President':10
                    };
                    // 从语义对照表补充职级映射
                    if (semanticCache.level) {
                        var lvLines = semanticCache.level.split('\n');
                        lvLines.forEach(function(line) {
                            var parts = line.split(' → ');
                            var key = parts[0];
                            var vals = (parts[1] || '').split('、');
                            // 确保 key_name 有档位
                            if (!rankLevels[key]) rankLevels[key] = 3; // 默认高级
                            vals.forEach(function(v) { if (v && !rankLevels[v]) rankLevels[v] = rankLevels[key]; });
                        });
                    }

                    function getLevelRank(text) {
                        if (!text) return 0;
                        var best = 0;
                        for (var lk in rankLevels) {
                            if (text.indexOf(lk) >= 0 && rankLevels[lk] > best) {
                                best = rankLevels[lk];
                            }
                        }
                        return best;
                    }

                    var jdRankLevel = getLevelRank((jdRank || '') + (jdTitle || ''));
                    var candRankLevel = getLevelRank((info?.latestPosition || '') + (info?.mainFunction || ''));
                    // 职级匹配：候选人 ≥ JD要求，或双方都无要求
                    var rankMet = jdRankLevel === 0 || candRankLevel >= jdRankLevel;
                    console.log('[DEBUG rank] jdRankLevel=' + jdRankLevel + ' candRankLevel=' + candRankLevel + ' met=' + rankMet);
                    console.log('[DEBUG targetList]', targetCompanies, '| candCompany=', candCompany);

                    // 目标公司无要求时不算缺失
                    var hasTargetList = targetList.length > 0;
                    if (!hasTargetList) targetMet = true;

                    // 代码级产品匹配兜底：目标公司+职能Match → 产品例外计20分
                    if (targetMet && func?.matchLevel === 'Match') {
                        prod.matchLevel = 'Match';
                        prod.productScore = Math.max(prod?.productScore || 0, 20);
                        console.log('[DEBUG product override] target+func match → product=Match/20');
                    }

                    // 职能Match时职位也按匹配算（语义等价，不扣字面Title）
                    var positionMetViaFunc = func?.matchLevel === 'Match';

                    // 跳槽频率：JD没要求时不算缺失
                    var hasHoppingReq = jdHopping && jdHopping.trim();

                    // 覆盖items中的关键项
                    items = items.map(function(it) {
                        if (it.name === '行业') it.met = (prod?.matchLevel !== 'Mismatch');
                        if (it.name === '产品') it.met = (prod?.matchLevel === 'Match');
                        if (it.name === '工作地点') { it.met = locationMet; it.jd = jdLocation; it.candidate = info?.workLocation || ''; }
                        if (it.name === '目标公司') { it.met = targetMet; it.jd = targetCompanies || '无要求'; it.candidate = candCompany; }
                        if (it.name === '工作年限') { it.met = expMet; it.jd = jdMinExp + '-' + jdMaxExp + '年'; it.candidate = expYears + '年'; }
                        if (it.name === '年龄') { it.met = ageMet; it.jd = jdMinAge + '-' + jdMaxAge + '岁'; it.candidate = age + '岁'; }
                        if (it.name === '学历') { it.met = eduMet; it.jd = jdEdu; it.candidate = info?.education || ''; }
                        if (it.name === '职位') { if (positionMetViaFunc) it.met = true; }
                        if (it.name === '职级') { if (rankMet) it.met = true; }
                        if (it.name === '跳槽频率') { if (!hasHoppingReq) it.met = true; }
                        return it;
                    });
                    console.log('[DEBUG items after override]', JSON.stringify(items.map(function(i){return {n:i.name, m:i.met};})));
                    var metCount = items.filter(function(it) { return it.met === true; }).length;
                    var totalCount = items.length || 1;
                    var mustPct = totalCount > 0 ? Math.round(metCount * 100 / totalCount) : 0;

                    // 从items中提取缺失项
                    var missingItems = items.filter(function(it) { return it.met === false; }).map(function(it) { return it.name; });

                    // Gate判定：产品+职能主线
                    // 强Gate规则（scoring_rules v3.0 第2条）：产品/职能任一 Mismatch → 直接 Mismatch 封顶30
                    var prodMatch = (prod?.matchLevel === 'Match');
                    var funcMatch = (func?.matchLevel === 'Match');
                    var prodMismatch = (prod?.matchLevel === 'Mismatch');
                    var funcMismatch = (func?.matchLevel === 'Mismatch');
                    var gatePath = 'Match';
                    if (prodMismatch || funcMismatch || mustPct < 30) {
                        gatePath = 'Mismatch';
                    } else if (mustPct < 60 || !prodMatch || !funcMatch) {
                        gatePath = 'Partial';
                    }
                    // 工作年限严重不达标（差距≥3年）：强制降级到Partial
                    if (expPenalty >= 20 && gatePath === 'Match') {
                        gatePath = 'Partial';
                    }

                    // Must缺失扣分（仅Match/Partial路径）：每缺1条扣3分（scoring_rules v3.0 第3条）
                    var deductScore = 0;
                    if (gatePath !== 'Mismatch') {
                        deductScore = missingItems.length * 3;
                    }

                    // 加分项（用代码级匹配结果）
                    var bonusScore = 0;
                    // 目标公司：匹配+20，无要求+10（不扣候选人的分）
                    if (targetMet && hasTargetList) bonusScore += 20;
                    else if (targetMet && !hasTargetList) bonusScore += 10;

                    var prefer = dim?.preferMet || 'none';
                    if (prefer === 'all') bonusScore += 10;
                    else if (prefer === 'partial') bonusScore += 5;

                    var hop = dim?.jobHoppingStability || 'normal';
                    if (hop === 'stable') bonusScore += 5;
                    else if (hop === 'normal') bonusScore += 2;

                    // 产品+职能双Match核心能力奖励
                    if (prodMatch && funcMatch) bonusScore += 5;

                    // 地点：代码级判断
                    if (locationMet) bonusScore += 5;

                    // 总分（含工作年限阶梯处罚）
                    var finalScore = baseScore + bonusScore - deductScore - expPenalty;
                    if (gatePath === 'Partial') finalScore = Math.min(finalScore, 59);
                    if (gatePath === 'Mismatch') finalScore = Math.min(finalScore, 30);
                    // Must有缺失时封顶（硬性要求不满足不能满分）
                    if (missingItems.length >= 3) finalScore = Math.min(finalScore, 79);
                    else if (missingItems.length >= 1) finalScore = Math.min(finalScore, 95);
                    finalScore = Math.max(0, Math.min(100, finalScore));

                    // 推荐等级
                    var overallRecommendation = '不需要联系';
                    if (finalScore >= 80) overallRecommendation = '强烈推荐';
                    else if (finalScore >= 60) overallRecommendation = '推荐';
                    else if (finalScore >= 50) overallRecommendation = '需电话确认';
                    else if (finalScore >= 40) overallRecommendation = '需人工查看';
                    else if (finalScore >= 20) overallRecommendation = '不建议联系';

                    // === 生成原因列表（代码主导，结合LLM补充） ===
                    var reasons = [];
                    var jdProductStr = jdProduct || '未知';
                    var jdTitleStr = jdTitle || '未知';
                    var candProductStr = info?.mainProduct || '未知';
                    var candFuncStr = info?.mainFunction || '未知';
                    var candCompanyStr = info?.latestCompany || '';
                    var candFuncDetail = info?.mainFunctionDetail || '';

                    // 核心：产品+职能匹配判断
                    var prodOk = prod?.matchLevel === 'Match';
                    var funcOk = func?.matchLevel === 'Match';

                    if (gatePath === 'Mismatch') {
                        // 一票否决原因
                        if (!prodOk) {
                            var prodReason = '产品主线为' + candProductStr;
                            if (candCompanyStr) prodReason += '（' + candCompanyStr + '）';
                            prodReason += '，JD要求' + jdProductStr + '，两者属不同产品方向';
                            if (candProductStr !== '未知' && jdProductStr !== '未知') {
                                prodReason += '（' + candProductStr + '≠' + jdProductStr + '）';
                            }
                            reasons.push(prodReason);
                        }
                        if (!funcOk) {
                            var funcReason = '职能主线为' + candFuncStr;
                            if (candFuncDetail) funcReason += '（' + candFuncDetail.substring(0, 50) + '）';
                            funcReason += '，JD要求' + jdTitleStr + '，职能领域不匹配';
                            reasons.push(funcReason);
                        }
                        if (!prodOk && !funcOk) {
                            reasons.push('产品+职能主线均不匹配，触发强Gate一票否决规则');
                        } else {
                            reasons.push('Must满足率仅' + mustPct + '%，触发Mismatch封顶规则');
                        }
                        if (!expMet) {
                            reasons.push('工作年限严重不达标：JD要求' + minExp + '年，候选人仅' + expYears + '年（差距' + expGap + '年）');
                        }
                    } else if (gatePath === 'Partial') {
                        if (prodOk && !funcOk) {
                            reasons.push('产品匹配（' + candProductStr + '=' + jdProductStr + '），但职能仅部分匹配');
                            reasons.push('职能主线为' + candFuncStr + '，与JD要求' + jdTitleStr + '不完全一致');
                        } else if (!prodOk && funcOk) {
                            reasons.push('职能匹配，但产品仅部分匹配（候选人' + candProductStr + '，JD要求' + jdProductStr + '）');
                        } else {
                            reasons.push('产品+职能均为部分匹配，进入Partial路径');
                        }
                        if (missingItems.length > 0) {
                            reasons.push('关键缺失项：' + missingItems.slice(0, 3).join('、'));
                        }
                        if (!expMet) {
                            reasons.push('工作年限严重不达标：JD要求' + minExp + '年，候选人仅' + expYears + '年（差距' + expGap + '年），扣' + expPenalty + '分');
                        }
                    } else {
                        // Match路径
                        if (prodOk) {
                            if (candProductStr !== '未知') {
                                reasons.push('产品匹配：候选人' + candProductStr + '方向与JD要求的' + jdProductStr + '一致');
                            } else if (prod?.reasoning) {
                                reasons.push('产品匹配：' + prod.reasoning);
                            } else {
                                reasons.push('产品匹配：与JD要求的' + jdProductStr + '一致');
                            }
                        }
                        if (funcOk && candFuncDetail) {
                            reasons.push('职能匹配：候选人' + candFuncDetail.substring(0, 60) + '，直接匹配JD' + jdTitleStr + '岗位要求');
                        } else if (funcOk) {
                            reasons.push('职能匹配：候选人' + candFuncStr + '经验与JD' + jdTitleStr + '岗位一致');
                        }
                        // 补充项
                        if (targetMet && hasTargetList) reasons.push('目标公司匹配：候选人当前在' + candCompanyStr + '任职');
                        if (!expMet) {
                            reasons.push('工作年限严重不达标：JD要求' + minExp + '年，候选人仅' + expYears + '年（差距' + (minExp - expYears) + '年），扣' + expPenalty + '分');
                        }
                        if (missingItems.length > 0) {
                            reasons.push('不满足项：' + missingItems.join('、'));
                        }
                    }

                    // 最后：如果LLM也有reasons，且代码生成的不够，补充LLM的
                    if (dim?.reasons && Array.isArray(dim.reasons)) {
                        var llmReasons = dim.reasons.filter(function(r) { return r && r.trim(); });
                        if (reasons.length < 2 && llmReasons.length > 0) {
                            reasons = reasons.concat(llmReasons.slice(0, 3));
                        }
                    }

                    var final = {
                        finalScore: finalScore,
                        baseScore: baseScore,
                        bonusScore: bonusScore,
                        deductScore: deductScore,
                        gatePath: gatePath,
                        overallRecommendation: overallRecommendation,
                        reasons: reasons,
                        detail: {
                            productScore: productScore,
                            functionScore: functionScore,
                            continuityScore: continuityScore,
                            educationScore: educationScore,
                            mustHaveMet: mustPct,
                            mustHaveMissing: missingItems,
                            items: items,
                            targetCompanyStatus: targetMet ? 'current' : 'none',
                            preferMet: prefer,
                            jobHoppingStability: hop,
                            locationMatch: locationMet ? 'exact' : 'mismatch'
                        }
                    };
                    sendEvent('step', { step: 4, name: '最终评分计算', status: 'done', result: final });

                    // 只返回打分规则要求的三个字段
                    var cleanResult = {
                        finalScore: final.finalScore,
                        reasons: final.reasons,
                        overallRecommendation: final.overallRecommendation
                    };
                    sendEvent('done', { finalScore: cleanResult });
                    res.end();
                })().catch(e => {
                    sendEvent('error', { message: e.message });
                    res.end();
                });
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/api/score-layered') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { jdText, resumeText, rules, targetCompanies, thinking, temperature, max_tokens } = JSON.parse(body);
                if (!jdText || !resumeText) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'jdText 和 resumeText 不能为空' }));
                }

                // SSE headers
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });

                function sendEvent(event, data) {
                    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
                }

                function callModelNonStream(sysPrompt, userPrompt, maxTok) {
                    return new Promise((resolve, reject) => {
                        const roundCap = maxTok || 2048;
                        const payload = {
                            model: MODEL,
                            messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }],
                            stream: false,
                            max_tokens: Math.min(max_tokens || roundCap, roundCap),
                            temperature: (typeof temperature === 'number') ? temperature : 0,
                            frequency_penalty: 0.3,
                            chat_template_kwargs: { enable_thinking: false },
                        };
                        if (payload.temperature === 0) payload.seed = 42;
                        const payloadStr = JSON.stringify(payload);
                        const url = new URL(VLLM_BASE + '/v1/chat/completions');
                        const llmReq = http.request({
                            hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payloadStr) }
                        }, (llmRes) => {
                            let d = '';
                            llmRes.on('data', c => d += c);
                            llmRes.on('end', () => {
                                try {
                                    const j = JSON.parse(d);
                                    resolve((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
                                } catch(e) { reject(new Error('Parse error')); }
                            });
                        });
                        llmReq.on('error', reject);
                        llmReq.write(payloadStr);
                        llmReq.end();
                    });
                }

                function extractJSON(text) {
                    var cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                    var codeBlock = cleaned.match(/```json\s*([\s\S]*?)```/);
                    if (codeBlock) { try { return JSON.parse(codeBlock[1].trim()); } catch(e) {} }
                    var matches = cleaned.match(/\{[\s\S]*\}/);
                    if (matches) { try { return JSON.parse(matches[0]); } catch(e) {} }
                    return null;
                }

                // ====== 月份差 ======
                function monthDiff(s, e) {
                    // 格式 YYYY-MM 或 YYYY/MM；至今/now 当作当前
                    function parseYM(x) {
                        if (!x || /至今|现在|now|present/i.test(String(x))) return [2026, 6];
                        var m = String(x).match(/(\d{4})[-\/\.](\d{1,2})/);
                        if (m) return [parseInt(m[1]), parseInt(m[2])];
                        var y = String(x).match(/(\d{4})/);
                        if (y) return [parseInt(y[1]), 1];
                        return null;
                    }
                    var a = parseYM(s), b = parseYM(e);
                    if (!a || !b) return 0;
                    return Math.max(0, (b[0]-a[0])*12 + (b[1]-a[1]));
                }

                // ====== JS 主线判定：三标准取二 ======
                function enrichExperiences(exps) {
                    if (!Array.isArray(exps) || exps.length === 0) return [];
                    var nowY = 2026, nowM = 6;  // 当前时间锚点（与 currentDate 对齐）
                    var rxCore = /负责|主导|牵头|主管|带领|主要承担|独立完成|leader|lead/i;

                    for (var i = 0; i < exps.length; i++) {
                        var e = exps[i] || {};
                        e.desc_len = (e.description || '').length;
                        e.months   = monthDiff(e.start, e.end);
                        // 近3年判定：end 距今 ≤ 36个月，或 end 是"至今"
                        var endMo = monthDiff(e.end, nowY + '-' + String(nowM).padStart(2,'0'));
                        e.is_recent_3y = (endMo <= 36) || /至今|现在|now|present/i.test(String(e.end || ''));
                        e.is_core_role = rxCore.test(e.description || '') || rxCore.test(e.title || '');
                        exps[i] = e;
                    }

                    var recent = exps.filter(function(e) { return e.is_recent_3y; });
                    if (recent.length === 0) {
                        exps.forEach(function(e) { e.is_main = false; });
                        return exps;
                    }
                    var totLen = recent.reduce(function(s, e) { return s + (e.desc_len || 0); }, 0) || 1;
                    var totMo  = recent.reduce(function(s, e) { return s + (e.months   || 0); }, 0) || 1;

                    for (var j = 0; j < exps.length; j++) {
                        var e2 = exps[j];
                        if (!e2.is_recent_3y) { e2.is_main = false; continue; }
                        var v = 0;
                        if ((e2.desc_len || 0) / totLen >= 0.5) v++;
                        if ((e2.months   || 0) / totMo  >= 0.6) v++;
                        if (e2.is_core_role) v++;
                        e2.is_main = (v >= 2);
                    }
                    return exps;
                }

                // ====== SYS1 升级：要 experiences 数组 ======
                const SYS1 = '你是简历信息提取专家。输出紧凑JSON（无空格无换行），不要额外文字。\n\n' +
                    '提取要点：\n' +
                    '- 行业：从公司业务/产品领域推断\n' +
                    '- mainProduct：最近工作核心产品名，20字内\n' +
                    '- mainProductDetail：1句话描述产品做什么，50字内\n' +
                    '- mainFunction：核心职能方向（非Title），15字内\n' +
                    '- mainFunctionDetail：职能内容+技术栈，50字内\n' +
                    '- otherProducts：历史其他产品，最多5个\n' +
                    '- experiences：按时间倒序的工作经历数组，最多5段，每段含：\n' +
                    '  · company公司名、title职位\n' +
                    '  · start/end 起止时间(YYYY-MM 格式；end为"至今"也可)\n' +
                    '  · description 该段工作描述(简历原文摘录，120字内，包含职责动词如"负责/主导/参与"等)\n' +
                    '- 无法确定填"未知"\n\n' +
                    'JSON格式：{"industry":"","mainProduct":"","mainProductDetail":"","otherProducts":[],"mainFunction":"","mainFunctionDetail":"","totalYears":0,"age":0,"latestCompany":"","latestPosition":"","education":"","school":"","jobCount":0,"avgTenure":0,"hasGap":false,"spcMention":false,"workLocation":"","willingToRelocate":false,"experiences":[{"company":"","title":"","start":"","end":"","description":""}]}';

                const SYS2_BASE = '你是产品匹配判断专家。\n' +
                    '【产品方向边界】\n' +
                    '- 同一大方向：三电/电驱/电控/电源/车载电子；机器人：本体/控制器/伺服/减速器；半导体：前道/后道/封测\n' +
                    '- 不同方向（必判 Mismatch）：底盘≠三电、自动驾驶≠通用软件、汽车电子≠消费电子、工业电源≠车载电源\n' +
                    '- 仅提及产品名无对应工作内容 → 不匹配；目标公司+职位完全对应可适度放宽\n' +
                    '【主线规则】非主线经历（is_main=false）最高 10 分；边缘经历计 0 分\n' +
                    '【对照表使用】候选人产品名可能与 JD 不同，参考下方对照表\n' +
                    '\n评分：产品主线+工作内容+行业匹配=20；产品+内容不匹配=10；仅提及=5；不匹配=0\n' +
                    '多产品：1条不扣；2条-5；≥3条-10。连续性：近1年主线不扣；新切入-5；跨域-10\n' +
                    '输出JSON（reasoning限20字）：{"productScore":分,"matchLevel":"Match/Partial/Mismatch","reasoning":"简短依据","multiProductDeduct":扣分,"continuityDeduct":扣分}';

                const SYS3_BASE = '你是职能匹配判断专家。\n' +
                    '【职能分类边界（跨大类必判 Mismatch）】\n' +
                    '- 研发类：软件/硬件/系统/测试/仿真/算法/机械结构\n' +
                    '- To C 营销类：区域销售/渠道管理/产品规划/产品营销/用户运营\n' +
                    '- 职能类：HR/财务/行政（不与研发、营销混淆）\n' +
                    '- 研发内部错配（硬件≠软件、测试≠算法）最高 10 分\n' +
                    '【主线规则】非主线经历不得标 Match，最高 10 分\n' +
                    '【对照表使用】参考下方对照表判断相邻职能\n' +
                    '\n评分：主线职能完全匹配=20；相邻=10；次要参与=5；边缘=0\n' +
                    '输出JSON（reasoning限20字）：{"functionScore":分,"matchLevel":"Match/Partial/Mismatch","reasoning":"简短依据"}';

                (async () => {
                    // 预加载语义对照
                    sendEvent('step', { step: 0, name: '加载语义对照表', status: 'running' });
                    var SYS2 = SYS2_BASE;
                    if (semanticCache.product) SYS2 += '\n\n【产品名对照表】\n' + semanticCache.product;
                    var SYS3 = SYS3_BASE;
                    if (semanticCache.function) SYS3 += '\n\n【职能对照表】\n' + semanticCache.function;
                    sendEvent('step', { step: 0, name: '加载语义对照表', status: 'done' });

                    // === R1: 简历抽取（带 experiences）===
                    sendEvent('step', { step: 1, name: '简历信息提取', status: 'running' });
                    const r1 = await callModelNonStream(SYS1, '提取简历信息：\n\n' + resumeText, 800);
                    const info = extractJSON(r1) || {};

                    // === JS enrich：算 is_main / desc_len / months ===
                    info.experiences = enrichExperiences(info.experiences || []);
                    var mainExps = (info.experiences || []).filter(function(e) { return e.is_main; });
                    var hasMainLine = mainExps.length > 0;
                    console.log('[layered] experiences=' + (info.experiences||[]).length + ' main=' + mainExps.length);
                    sendEvent('step', { step: 1, name: '简历信息提取', status: 'done', result: info });

                    // 主线摘要供 R2/R3 引用
                    var mainSummary = mainExps.length ? mainExps.map(function(e) {
                        return e.company + '/' + (e.title||'') + '/' + (e.start||'') + '~' + (e.end||'') + '/' + (e.description||'').substring(0, 80);
                    }).join('\n') : '（候选人近3年无清晰主线经历）';

                    // === R2: 产品匹配 ===
                    sendEvent('step', { step: 2, name: '产品匹配判断', status: 'running' });
                    var jdDuty = (jdText.match(/工作职责[：:]\s*([\s\S]*?)(?=\n\S|原始要求|【|$)/) || [])[1] || '';
                    var jdRawReq = (jdText.match(/原始要求[：:]\s*([\s\S]*?)(?=\n\S|【|$)/) || [])[1] || '';
                    var otherProds = (info?.otherProducts || []).join('、');
                    const r2Input = 'JD产品：' + (jdText.match(/产品[：:]\s*(.+)/)?.[1] || '未知') + '\nJD行业：' + (jdText.match(/行业[：:]\s*(.+)/)?.[1] || '未知') + '\nJD目标公司：' + (targetCompanies || '无') + '\nJD工作职责：' + (jdDuty || '无') + '\nJD原始要求：' + (jdRawReq || '无') + '\n\n【候选人提取信息】\n行业=' + (info?.industry || '') + '\n主线产品=' + (info?.mainProduct || '') + '\n工作内容=' + (info?.mainProductDetail || '') + '\n其他产品=' + (otherProds || '无') + '\n最近公司=' + (info?.latestCompany || '') + '\n最近职位=' + (info?.latestPosition || '') + '\n\n【近3年主线经历(JS判定)】\n' + mainSummary + '\n\n【候选人原始简历(参考)】\n' + (resumeText || '').substring(0, 2000);
                    const r2 = await callModelNonStream(SYS2, r2Input, 360);
                    const prod = extractJSON(r2) || {};
                    sendEvent('step', { step: 2, name: '产品匹配判断', status: 'done', result: prod });

                    // === R3: 职能匹配 ===
                    sendEvent('step', { step: 3, name: '职能匹配判断', status: 'running' });
                    const r3Input = 'JD职位：' + (jdText.match(/职位名称[：:]\s*(.+)/)?.[1] || '未知') + '\nJD职责：' + (jdText.match(/工作职责[：:]\s*(.+)/)?.[1] || '未知') + '\n\n【候选人提取信息】\n职能=' + (info?.mainFunction || '') + '\n职能内容=' + (info?.mainFunctionDetail || '') + '\n职位=' + (info?.latestPosition || '') + '\n\n【近3年主线经历(JS判定)】\n' + mainSummary + '\n\n【候选人原始简历(参考)】\n' + (resumeText || '').substring(0, 2000);
                    const r3 = await callModelNonStream(SYS3, r3Input, 360);
                    const func = extractJSON(r3) || {};
                    sendEvent('step', { step: 3, name: '职能匹配判断', status: 'done', result: func });

                    // === 非主线封顶 10 分（scoring_rules v3.0 第4条）===
                    if (!hasMainLine && (info.experiences || []).length > 0) {
                        if ((prod?.productScore || 0) > 10) {
                            console.log('[layered cap] 无主线 → productScore ' + prod.productScore + ' → 10');
                            prod.productScore = 10;
                            if (prod.matchLevel === 'Match') prod.matchLevel = 'Partial';
                        }
                        if ((func?.functionScore || 0) > 10) {
                            console.log('[layered cap] 无主线 → functionScore ' + func.functionScore + ' → 10');
                            func.functionScore = 10;
                            if (func.matchLevel === 'Match') func.matchLevel = 'Partial';
                        }
                    }

                    // === [R4 砍除] 代码兜底 dim ===
                    sendEvent('step', { step: 4, name: '最终评分计算', status: 'running' });

                    var jdIndustry = (jdText.match(/行业[：:]\s*(.+)/) || [])[1] || '';
                    var jdProduct = (jdText.match(/产品[：:]\s*(.+)/) || [])[1] || '';
                    var jdMinExp = (jdText.match(/最低工作年限[：:]\s*(\d+)/) || [])[1] || '';
                    var jdMaxExp = (jdText.match(/最高工作年限[：:]\s*(\d+)/) || [])[1] || '';
                    var jdMinAge = (jdText.match(/最小年龄[：:]\s*(\d+)/) || [])[1] || '';
                    var jdMaxAge = (jdText.match(/最大年龄[：:]\s*(\d+)/) || [])[1] || '';
                    var jdEdu = (jdText.match(/学历要求[：:]\s*(.+)/) || [])[1] || '';
                    var jdHopping = (jdText.match(/跳槽频率[：:]\s*(.+)/) || [])[1] || '';
                    var jdLocation = (jdText.match(/工作(?:城市|地点)[：:]\s*(.+)/) || [])[1] || '';
                    var jdTitle = (jdText.match(/职位名称[：:]\s*(.+)/) || [])[1] || '';
                    var jdRank = (jdText.match(/职级[：:]\s*(.+)/) || [])[1] || '';

                    var _eduStr = info?.education || '';
                    var _py_education = (_eduStr.indexOf('博') >= 0 || _eduStr.indexOf('硕') >= 0 || _eduStr.indexOf('本科') >= 0) ? 10
                                      : (_eduStr.indexOf('大专') >= 0 || _eduStr.indexOf('专科') >= 0) ? 5 : 0;
                    var _jc = parseInt(info?.jobCount) || 0;
                    var _py_continuity = (_jc === 0) ? 5 : (_jc <= 3 ? 10 : (_jc <= 5 ? 5 : 0));
                    var _at = parseFloat(info?.avgTenure) || 0;
                    var _py_stability = _at >= 2.5 ? 'stable' : (_at >= 1.5 ? 'normal' : 'unstable');
                    var _py_prefer = 'partial';

                    const dim = {
                        items: [
                            { name: '行业', met: false }, { name: '产品', met: false },
                            { name: '工作年限', met: false }, { name: '年龄', met: false },
                            { name: '学历', met: false }, { name: '职级', met: false },
                            { name: '职位', met: false }, { name: '跳槽频率', met: false },
                            { name: '工作地点', met: false }, { name: '目标公司', met: false },
                            { name: 'SPC技能', met: false }
                        ],
                        continuityScore: _py_continuity,
                        educationScore: _py_education,
                        preferMet: _py_prefer,
                        jobHoppingStability: _py_stability
                    };
                    dim.items[10].met = !!info?.spcMention;

                    // === 代码兜底各项 met ===
                    var jdCities = jdLocation.split(/[\/、,，\s]+/).filter(Boolean);
                    var candCities = (info?.workLocation || '').split(/[\/、,，\s]+/).filter(Boolean);
                    var locationMet = jdCities.some(function(jc) { return candCities.some(function(cc) { return cc.indexOf(jc) >= 0 || jc.indexOf(cc) >= 0; }); });
                    if (!locationMet && (info?.willingToRelocate === true || info?.willingToRelocate === '是')) locationMet = true;

                    var targetList = (targetCompanies || '').replace(/^\[|\]$/g, '').trim().split(/[、,，\s]+/).filter(Boolean);
                    var candCompany = info?.latestCompany || '';
                    var targetMet = targetList.some(function(tc) { return candCompany.indexOf(tc) >= 0 || tc.indexOf(candCompany) >= 0; });

                    var expYears = parseFloat(info?.totalYears) || 0;
                    var minExp = parseFloat(jdMinExp) || 0;
                    var maxExp = parseFloat(jdMaxExp) || 99;
                    // 浮动 ±1 年：边界差距 ≤1 年视为达标，但保留轻扣（铁律8 "酌情放宽"）
                    var expGap = minExp - expYears;          // >0 = 经验不足
                    var expOverGap = expYears - maxExp;      // >0 = 经验超龄
                    var expMet, expPenalty = 0;
                    if (expGap <= 1 && expOverGap <= 1) {
                        expMet = true;
                        if (expGap > 0 || expOverGap > 0) expPenalty = 3;  // 边界轻扣
                    } else if (expGap > 1) {
                        expMet = false;
                        expPenalty = (expGap >= 3) ? 20 : 10;
                    } else {
                        expMet = false;                       // 超龄 >1 年
                        expPenalty = 5;
                    }

                    var age = parseFloat(info?.age) || 0;
                    var minAge = parseFloat(jdMinAge) || 0;
                    var maxAge = parseFloat(jdMaxAge) || 99;
                    var ageMet = age >= minAge && age <= maxAge;

                    var eduMap = {'高中':1,'中专':1,'大专':2,'专科':2,'本科':3,'硕士':4,'博士':5};
                    var jdEduLevel = eduMap[jdEdu] || 3;
                    var candEduLevel = 0;
                    for (var ek in eduMap) {
                        if ((info?.education || '').indexOf(ek) >= 0) candEduLevel = Math.max(candEduLevel, eduMap[ek]);
                    }
                    var eduMet = candEduLevel >= jdEduLevel;

                    var rankLevels = {
                        '初级':1,'初级工程师':1,'助理工程师':1,'Junior':1,
                        '工程师':2,'Engineer':2,
                        '高级工程师':3,'Senior Engineer':3,
                        '资深工程师':4,'Staff Engineer':4,'主管':4,'Team Lead':4,
                        '专家':5,'经理':5,'Manager':5,
                        '高级经理':6,'Senior Manager':6,'副总监':6,
                        '总监':7,'Director':7,
                        '高级总监':8,'总经理':8,'GM':8,
                        '副总裁':9,'VP':9,'总裁':10
                    };
                    if (semanticCache.level) {
                        semanticCache.level.split('\n').forEach(function(line) {
                            var parts = line.split(' → ');
                            var key = parts[0];
                            var vals = (parts[1] || '').split('、');
                            if (!rankLevels[key]) rankLevels[key] = 3;
                            vals.forEach(function(v) { if (v && !rankLevels[v]) rankLevels[v] = rankLevels[key]; });
                        });
                    }
                    function getLevelRank(text) {
                        if (!text) return 0;
                        var best = 0;
                        for (var lk in rankLevels) {
                            if (text.indexOf(lk) >= 0 && rankLevels[lk] > best) best = rankLevels[lk];
                        }
                        return best;
                    }
                    var jdRankLevel = getLevelRank((jdRank || '') + (jdTitle || ''));
                    var candRankLevel = getLevelRank((info?.latestPosition || '') + (info?.mainFunction || ''));
                    var rankMet = jdRankLevel === 0 || candRankLevel >= jdRankLevel;

                    var hasTargetList = targetList.length > 0;
                    if (!hasTargetList) targetMet = true;

                    // 目标公司+职能 Match → 产品例外
                    if (targetMet && hasTargetList && func?.matchLevel === 'Match') {
                        prod.matchLevel = 'Match';
                        prod.productScore = Math.max(prod?.productScore || 0, 20);
                    }
                    var positionMetViaFunc = func?.matchLevel === 'Match';
                    var hasHoppingReq = jdHopping && jdHopping.trim();

                    var items = dim.items.map(function(it) {
                        if (it.name === '行业') it.met = (prod?.matchLevel !== 'Mismatch');
                        if (it.name === '产品') it.met = (prod?.matchLevel === 'Match');
                        if (it.name === '工作地点') { it.met = locationMet; it.jd = jdLocation; it.candidate = info?.workLocation || ''; }
                        if (it.name === '目标公司') { it.met = targetMet; it.jd = targetCompanies || '无要求'; it.candidate = candCompany; }
                        if (it.name === '工作年限') { it.met = expMet; it.jd = jdMinExp + '-' + jdMaxExp + '年'; it.candidate = expYears + '年'; }
                        if (it.name === '年龄') { it.met = ageMet; it.jd = jdMinAge + '-' + jdMaxAge + '岁'; it.candidate = age + '岁'; }
                        if (it.name === '学历') { it.met = eduMet; it.jd = jdEdu; it.candidate = info?.education || ''; }
                        if (it.name === '职位') { if (positionMetViaFunc) it.met = true; }
                        if (it.name === '职级') { if (rankMet) it.met = true; }
                        if (it.name === '跳槽频率') { if (!hasHoppingReq) it.met = true; }
                        return it;
                    });
                    var metCount = items.filter(function(it) { return it.met === true; }).length;
                    var totalCount = items.length || 1;
                    var mustPct = Math.round(metCount * 100 / totalCount);
                    var missingItems = items.filter(function(it) { return it.met === false; }).map(function(it) { return it.name; });

                    // ============================================================
                    //  Layer0 首层门槛（四维独立百分制）
                    // ============================================================
                    var prodPct = (prod?.productScore || 0) * 5;   // 20分制 → 百分制
                    var funcPct = (func?.functionScore || 0) * 5;
                    var rankPct = rankMet ? 100 : (candRankLevel > 0 && jdRankLevel > 0 && candRankLevel >= jdRankLevel - 1 ? 50 : 0);
                    var industryPct = (prod?.matchLevel === 'Match') ? 100 : (prod?.matchLevel === 'Partial') ? 50 : 0;
                    var layer0Score = Math.round((prodPct + funcPct + rankPct + industryPct) / 4);
                    console.log('[layered Layer0] prod=' + prodPct + ' func=' + funcPct + ' rank=' + rankPct + ' ind=' + industryPct + ' → ' + layer0Score);

                    var gatePath = 'Match', finalScore = 0, reasons = [];
                    var layer0Pass = layer0Score >= 70;
                    var layer1Pass = expMet && ageMet && eduMet && rankMet;

                    if (!layer0Pass) {
                        // Layer0 未过 → 锁30
                        gatePath = 'Mismatch';
                        finalScore = 30;
                        reasons.push('Layer0 首层门槛分仅 ' + layer0Score + '/100（产品' + prodPct + '+职能' + funcPct + '+职级' + rankPct + '+行业' + industryPct + '）<70，锁30分');
                        if (prodPct < 50) reasons.push('产品方向不匹配（候选人' + (info?.mainProduct || '未知') + ' vs JD ' + (jdProduct || '未知') + '）');
                        if (funcPct < 50) reasons.push('职能方向不匹配（候选人' + (info?.mainFunction || '未知') + ' vs JD ' + (jdTitle || '未知') + '）');
                    } else {
                        // Layer0 通过，按 Must 满足率定 gate
                        var prodMatch = (prod?.matchLevel === 'Match');
                        var funcMatch = (func?.matchLevel === 'Match');
                        var prodMismatch = (prod?.matchLevel === 'Mismatch');
                        var funcMismatch = (func?.matchLevel === 'Mismatch');
                        if (prodMismatch || funcMismatch || mustPct < 30) gatePath = 'Mismatch';
                        else if (mustPct < 60 || !prodMatch || !funcMatch) gatePath = 'Partial';

                        // baseScore
                        var baseScore = (prod?.productScore || 0) + (func?.functionScore || 0) + dim.continuityScore + dim.educationScore;

                        var deductScore = (gatePath !== 'Mismatch') ? missingItems.length * 3 : 0;

                        // ============================================================
                        //  Layer1 校验 / Layer2 加分
                        // ============================================================
                        var bonusScore = 0;
                        if (layer1Pass) {
                            if (targetMet && hasTargetList) bonusScore += 20;
                            else if (targetMet && !hasTargetList) bonusScore += 10;
                            if (dim.preferMet === 'all') bonusScore += 10;
                            else if (dim.preferMet === 'partial') bonusScore += 5;
                            if (dim.jobHoppingStability === 'stable') bonusScore += 5;
                            else if (dim.jobHoppingStability === 'normal') bonusScore += 2;
                            if (prodMatch && funcMatch) bonusScore += 5;
                            if (locationMet) bonusScore += 5;
                        } else {
                            reasons.push('Layer1 硬性项未全达标（年限=' + expMet + ' 年龄=' + ageMet + ' 学历=' + eduMet + ' 职级=' + rankMet + '），跳过加分项');
                        }

                        finalScore = baseScore + bonusScore - deductScore - expPenalty;
                        if (gatePath === 'Partial') finalScore = Math.min(finalScore, 59);
                        if (gatePath === 'Mismatch') finalScore = Math.min(finalScore, 30);
                        if (missingItems.length >= 3) finalScore = Math.min(finalScore, 79);
                        else if (missingItems.length >= 1) finalScore = Math.min(finalScore, 95);

                        // 主线信息加入原因
                        if (!hasMainLine && (info.experiences || []).length > 0) {
                            reasons.push('近3年无清晰主线经历（experiences=' + info.experiences.length + '段，主线=0），产品/职能分已 cap 10');
                        }
                        if (gatePath === 'Mismatch') {
                            if (prodMismatch) reasons.push('产品主线不匹配（' + (info?.mainProduct || '未知') + '≠' + (jdProduct || '未知') + '）');
                            if (funcMismatch) reasons.push('职能主线不匹配（' + (info?.mainFunction || '未知') + '≠' + (jdTitle || '未知') + '）');
                            if (mustPct < 30) reasons.push('Must满足率仅' + mustPct + '%');
                        } else if (gatePath === 'Partial') {
                            if (prodMatch && !funcMatch) reasons.push('产品匹配，职能仅部分匹配');
                            else if (!prodMatch && funcMatch) reasons.push('职能匹配，产品仅部分匹配');
                            else reasons.push('产品+职能均部分匹配');
                            if (missingItems.length) reasons.push('关键缺失：' + missingItems.slice(0, 3).join('、'));
                        } else {
                            if (prodMatch) reasons.push('产品匹配：' + (info?.mainProduct || '') + ' 方向与 JD ' + (jdProduct || '') + ' 一致');
                            if (funcMatch) reasons.push('职能匹配：' + (info?.mainFunctionDetail || info?.mainFunction || '').substring(0, 60));
                            if (targetMet && hasTargetList) reasons.push('目标公司匹配：' + candCompany);
                            if (missingItems.length) reasons.push('不满足项：' + missingItems.join('、'));
                        }
                        if (!expMet && expPenalty > 0) {
                            reasons.push('工作年限不达标：JD要求' + minExp + '年，候选人' + expYears + '年，扣' + expPenalty + '分');
                        }
                    }

                    finalScore = Math.max(0, Math.min(100, finalScore));
                    var overallRecommendation = '不需要联系';
                    if (finalScore >= 80) overallRecommendation = '强烈推荐';
                    else if (finalScore >= 60) overallRecommendation = '推荐';
                    else if (finalScore >= 50) overallRecommendation = '需电话确认';
                    else if (finalScore >= 40) overallRecommendation = '需人工查看';
                    else if (finalScore >= 20) overallRecommendation = '不建议联系';

                    var final = {
                        finalScore: finalScore,
                        layer0Score: layer0Score,
                        layer0Pass: layer0Pass,
                        layer1Pass: layer1Pass,
                        gatePath: gatePath,
                        overallRecommendation: overallRecommendation,
                        reasons: reasons,
                        detail: {
                            productScore: prod?.productScore || 0,
                            functionScore: func?.functionScore || 0,
                            continuityScore: dim.continuityScore,
                            educationScore: dim.educationScore,
                            mustHaveMet: mustPct,
                            mustHaveMissing: missingItems,
                            items: items,
                            mainLineCount: mainExps.length,
                            experiencesCount: (info.experiences || []).length,
                            layer0Detail: { product: prodPct, function: funcPct, rank: rankPct, industry: industryPct }
                        }
                    };
                    sendEvent('step', { step: 4, name: '最终评分计算', status: 'done', result: final });

                    var cleanResult = {
                        finalScore: final.finalScore,
                        reasons: final.reasons,
                        overallRecommendation: final.overallRecommendation
                    };
                    sendEvent('done', { finalScore: cleanResult });
                    res.end();
                })().catch(e => {
                    sendEvent('error', { message: e.message });
                    res.end();
                });
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Chat server running on http://0.0.0.0:${PORT}`);
    console.log(`vLLM backend: ${VLLM_BASE}`);
    console.log(`Model: ${MODEL}`);
});
