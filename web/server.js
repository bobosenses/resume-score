const http = require('http');
const fs = require('fs');
const path = require('path');

const MODEL = process.env.VLLM_MODEL || 'Qwen/Qwen3-8B-FP8';
const VLLM_BASE = process.env.VLLM_BASE || 'http://127.0.0.1:8000';
const PORT = process.env.PORT || 3000;
const INDEX_PATH = path.join(__dirname, 'index.html');
const BENCHMARK_PATH = path.join(__dirname, 'benchmark.html');
const LOGS_PATH = path.join(__dirname, 'logs.html');
const TEST_CASES_PATH = path.join(__dirname, '..', 'test', 'resume_test_cases.json');
const DEFAULT_TEST_CASE_PATH = path.join(__dirname, '123.txt');
const SCORING_RULES_PATH = path.join(__dirname, '..', 'config', 'scoring_rules.json');
const PARSE_RULES_PATH = path.join(__dirname, '..', 'config', 'parse_rules.json');
const PROXY_BASE = process.env.PROXY_BASE || 'http://127.0.0.1:8000';

// ========== Helper: call vLLM chat/completions and stream back Ollama-style generate chunks ==========
function streamChatCompletion(messages, options, res) {
    const vllmPayload = {
        model: options.model || MODEL,
        messages: messages,
        stream: true,
        max_tokens: options.max_tokens || 600,
        temperature: options.temperature || 0.1,
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
        temperature: (parsed.options && parsed.options.temperature) || 0.1,
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
        temperature: options.temperature || 0.1,
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

    res.writeHead(404);
    res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Chat server running on http://0.0.0.0:${PORT}`);
    console.log(`vLLM backend: ${VLLM_BASE}`);
    console.log(`Model: ${MODEL}`);
});
