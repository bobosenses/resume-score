#!/usr/bin/env python3
"""
Rules Injection Proxy for vLLM
- 监听端口 8000，将请求转发到 vLLM（端口 8001）
- 对 /v1/chat/completions 请求，当 use_scoring_rules=true 时自动注入打分规则
- 打分规则从 /root/vLLM/config/scoring_rules.json 实时读取（热加载）
- 提供规则管理 API：GET/PUT /api/scoring-rules
- 提供请求日志查询 API：GET /api/logs, GET /api/logs/stats
"""

import asyncio
import json
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime
from functools import partial
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, Request, HTTPException, Query
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# 导入日志数据库模块
from log_db import insert_log, query_logs, get_log_detail, get_stats

# ========== 配置 ==========
BASE_DIR = Path(__file__).parent
VLLM_BASE = os.getenv("VLLM_BASE", "http://127.0.0.1:8003")
PROXY_PORT = int(os.getenv("PROXY_PORT", "8000"))
RULES_FILE = os.getenv("RULES_FILE", str(BASE_DIR / "config" / "scoring_rules.json"))

# ========== 异步日志写入（避免阻塞事件循环） ==========
def _insert_log_sync(**kwargs):
    """同步日志写入，在线程池中执行"""
    return insert_log(**kwargs)


async def async_insert_log(**kwargs):
    """异步日志写入，将同步 SQLite 操作丢到线程池"""
    return await asyncio.get_running_loop().run_in_executor(
        None, partial(_insert_log_sync, **kwargs)
    )


# ========== 全局 httpx 客户端（连接复用） ==========
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时创建共享客户端，提高连接池上限
    app.state.http = httpx.AsyncClient(
        timeout=httpx.Timeout(600.0),
        limits=httpx.Limits(max_connections=200, max_keepalive_connections=50),
    )
    try:
        yield
    finally:
        await app.state.http.aclose()


app = FastAPI(title="Rules Injection Proxy", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ========== 规则文件读取（热加载） ==========
def load_scoring_rules() -> dict:
    """从文件实时读取打分规则"""
    try:
        with open(RULES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {"enabled": False, "error": "规则文件不存在"}
    except json.JSONDecodeError:
        return {"enabled": False, "error": "规则文件格式错误"}


def save_scoring_rules(data: dict) -> None:
    """将打分规则写入文件"""
    os.makedirs(os.path.dirname(RULES_FILE), exist_ok=True)
    data["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S+08:00")
    with open(RULES_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# ========== 规则注入逻辑 ==========
def inject_rules_into_messages(messages: list, rules_config: dict) -> list:
    """将打分规则注入到 messages 中"""
    if not rules_config.get("enabled", True):
        return messages

    system_prompt = rules_config.get("system_prompt", "")
    rules_text = rules_config.get("rules", "")

    full_system = system_prompt + "\n\n=== 打分规则 ===\n" + rules_text

    # 构建新的 messages 列表
    new_messages = []

    # 移除已有的 system 消息（避免重复）
    for msg in messages:
        if msg.get("role") != "system":
            new_messages.append(msg)

    # 在最前面插入 system 消息
    new_messages.insert(0, {"role": "system", "content": full_system})

    return new_messages


# ========== 规则管理 API ==========
@app.get("/api/scoring-rules")
def get_scoring_rules():
    """查看当前打分规则"""
    rules = load_scoring_rules()
    # 返回时截断过长的 rules 文本，提供摘要
    summary = dict(rules)
    if "rules" in summary and len(summary["rules"]) > 200:
        summary["rules_preview"] = summary["rules"][:200] + "..."
        summary["rules_length"] = len(summary["rules"])
        del summary["rules"]
    return summary


@app.put("/api/scoring-rules")
async def update_scoring_rules(request: Request):
    """更新打分规则"""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="无效的 JSON 格式")

    # 验证必要字段
    if "rules" not in body:
        raise HTTPException(status_code=400, detail="缺少 rules 字段")

    # 保留原有的元信息字段，更新规则内容
    current = load_scoring_rules()
    current.update({
        "rules": body["rules"],
        "enabled": body.get("enabled", True),
    })
    if "system_prompt" in body:
        current["system_prompt"] = body["system_prompt"]
    if "version" in body:
        current["version"] = body["version"]
    if "description" in body:
        current["description"] = body["description"]

    save_scoring_rules(current)

    return {
        "message": "规则更新成功",
        "version": current.get("version"),
        "updated_at": current["updated_at"],
        "rules_length": len(current["rules"]),
    }


@app.post("/api/scoring-rules/reload")
def reload_scoring_rules():
    """手动触发重新加载（验证文件是否有效）"""
    rules = load_scoring_rules()
    if "error" in rules:
        return {"status": "error", "message": rules["error"]}
    return {
        "status": "ok",
        "version": rules.get("version"),
        "enabled": rules.get("enabled"),
        "rules_length": len(rules.get("rules", "")),
    }


# ========== 日志查询 API ==========
@app.get("/api/logs")
def get_logs(
    start_time: Optional[str] = Query(None, description="开始时间 (YYYY-MM-DD HH:MM:SS)"),
    end_time: Optional[str] = Query(None, description="结束时间 (YYYY-MM-DD HH:MM:SS)"),
    client_ip: Optional[str] = Query(None, description="客户端 IP"),
    status_code: Optional[int] = Query(None, description="HTTP 状态码"),
    use_scoring_rules: Optional[bool] = Query(None, description="是否使用打分规则"),
    keyword: Optional[str] = Query(None, description="关键字搜索"),
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(20, ge=1, le=100, description="每页数量")
):
    """查询请求日志"""
    return query_logs(
        start_time=start_time,
        end_time=end_time,
        client_ip=client_ip,
        status_code=status_code,
        use_scoring_rules=use_scoring_rules,
        keyword=keyword,
        page=page,
        page_size=page_size
    )


@app.get("/api/logs/{log_id}")
def get_log_by_id(log_id: int):
    """获取单条日志详情"""
    log = get_log_detail(log_id)
    if not log:
        raise HTTPException(status_code=404, detail="日志不存在")
    return log


@app.get("/api/logs/stats/summary")
def get_log_stats(hours: int = Query(24, ge=1, le=168, description="统计时间范围（小时）")):
    """获取日志统计信息"""
    return get_stats(hours=hours)


# ========== 多轮打分代理 ==========
WEB_BASE = os.getenv("WEB_BASE", "http://127.0.0.1:3000")


@app.post("/api/score-multi-round")
async def score_multi_round(request: Request):
    """多轮打分 — 代理到 Node.js Web Server，流式返回 SSE"""
    body = await request.body()

    async def generate():
        async with request.app.state.http.stream(
            "POST",
            f"{WEB_BASE}/api/score-multi-round",
            content=body,
            headers={"Content-Type": "application/json"},
        ) as resp:
            async for chunk in resp.aiter_bytes():
                yield chunk

    return StreamingResponse(
        generate(),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


# ========== vLLM 代理 ==========
async def proxy_to_vllm(method: str, path: str, request: Request) -> httpx.Response:
    """将请求转发到 vLLM"""
    url = f"{VLLM_BASE}{path}"
    body = await request.body()

    # 构建转发用的 headers（去除 hop-by-hop headers）
    headers = {}
    for key, value in request.headers.items():
        lower = key.lower()
        if lower not in ("host", "content-length", "transfer-encoding"):
            headers[key] = value

    resp = await request.app.state.http.request(
        method=method,
        url=url,
        content=body,
        headers=headers,
    )
    return resp


async def proxy_stream_to_vllm(http_client: httpx.AsyncClient, method: str, path: str, body: bytes, headers: dict):
    """流式代理到 vLLM — 复用全局 http_client，避免 StreamClosed"""
    url = f"{VLLM_BASE}{path}"

    forward_headers = {}
    for key, value in headers.items():
        lower = key.lower()
        if lower not in ("host", "content-length", "transfer-encoding"):
            forward_headers[key] = value

    async def generate():
        async with http_client.stream(
            method=method,
            url=url,
            content=body,
            headers=forward_headers,
        ) as resp:
            async for chunk in resp.aiter_bytes():
                yield chunk

    return StreamingResponse(generate(), media_type="text/event-stream")


# ========== 路由处理 ==========
@app.get("/")
async def root():
    return {"service": "Rules Injection Proxy", "vllm_backend": VLLM_BASE}


@app.get("/health")
async def health(request: Request):
    """健康检查"""
    try:
        resp = await request.app.state.http.get(f"{VLLM_BASE}/health", timeout=httpx.Timeout(5.0))
        vllm_ok = resp.status_code == 200
    except Exception:
        vllm_ok = False

    rules = load_scoring_rules()
    rules_ok = "error" not in rules and rules.get("enabled", False)

    return {
        "proxy": "ok",
        "vllm": "ok" if vllm_ok else "unreachable",
        "scoring_rules": "ok" if rules_ok else "disabled",
    }


@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def vllm_proxy(request: Request, path: str):
    """透传 vLLM 所有接口，对 chat/completions 做规则注入"""
    full_path = f"/v1/{path}"
    start_time = time.time()
    client_ip = request.client.host if request.client else "unknown"

    # 非 chat/completions 请求直接透传
    if path != "chat/completions" or request.method != "POST":
        resp = await proxy_to_vllm(request.method, full_path, request)
        duration_ms = (time.time() - start_time) * 1000

        # 记录日志
        try:
            request_body = (await request.body()).decode("utf-8", errors="ignore")
        except:
            request_body = None

        await async_insert_log(
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            client_ip=client_ip,
            method=request.method,
            path=full_path,
            request_body=request_body[:10000] if request_body else None,  # 限制长度
            response_body=None,
            status_code=resp.status_code,
            duration_ms=round(duration_ms, 2),
            use_scoring_rules=False
        )

        return JSONResponse(
            content=resp.json() if resp.headers.get("content-type", "").startswith("application/json") else resp.text,
            status_code=resp.status_code,
        )

    # chat/completions 请求：检查是否需要注入规则
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="无效的 JSON")

    # 提取关键信息用于日志（不记录规则内容）
    use_rules = body.pop("use_scoring_rules", False)
    multi_round = body.pop("multi_round", False)
    model = body.get("model", "")
    messages = body.get("messages", [])

    # ========== 多轮打分模式 ==========
    if multi_round:
        # 从 messages / body 中智能提取 JD、简历、规则、目标公司
        jd_text = ""
        resume_text = ""
        rules_text = ""
        target_companies = ""

        # 先尝试 body 直接字段
        jd_text = body.pop("jd_text", body.pop("jdText", ""))
        resume_text = body.pop("resume_text", body.pop("resumeText", ""))
        rules_text = body.pop("rules", body.pop("scoring_rules", ""))
        target_companies = body.pop("target_companies", body.pop("targetCompanies", ""))

        # 如果 body 字段不全，从 messages 中提取
        user_contents = []
        for msg in messages:
            content = msg.get("content", "").strip()
            if not content:
                continue
            role = msg.get("role", "")
            if role == "system" and not rules_text:
                rules_text = content
            elif role == "user":
                user_contents.append(content)

        if not jd_text or not resume_text:
            # 合并所有 user 消息
            raw = "\n".join(user_contents)

            # 策略: 按已知章节标记切分内容
            # 常见的 section 标记（按优先级排列）
            section_patterns = [
                # (匹配标记的正则, 字段名, 止于哪些后续标记)
                (r'-\s*职位描述\s*[（(]?\s*JD\s*[）)]?\s*[：:]', 'jd'),
                (r'-\s*JD\s*[：:]', 'jd'),
                (r'(?:===?\s*(?:项目描述|JD|职位信息|职位描述|岗位描述)\s*===?)', 'jd'),
                (r'【职位信息】', 'jd'),
                (r'【硬性要求】', 'jd'),
                (r'-\s*候选人简历\s*[：:]', 'resume'),
                (r'-\s*简历内容\s*[：:]', 'resume'),
                (r'-\s*简历\s*[：:]', 'resume'),
                (r'候选人简历[：:]', 'resume'),
                (r'简历内容[：:]', 'resume'),
                (r'-\s*MustHave内容\s*[：:]', 'musthave'),
                (r'-\s*Prefer内容\s*[：:]', 'prefer'),
                (r'-\s*目标公司内容\s*[：:]', 'target'),
            ]

            # 找到所有标记的位置
            sections = []  # [(start, end, field, marker_text)]
            for pat, field in section_patterns:
                for m in re.finditer(pat, raw):
                    sections.append((m.start(), m.end(), field))

            # 按位置排序
            sections.sort(key=lambda x: x[0])

            # 提取各段内容
            musthave_text = ""
            prefer_text = ""
            for i, (sec_start, sec_end, field) in enumerate(sections):
                # 内容从标记结束到下一个标记开始（或文本末尾）
                content_start = sec_end
                content_end = sections[i + 1][0] if i + 1 < len(sections) else len(raw)
                content = raw[content_start:content_end].strip()

                if field == 'jd' and not jd_text and content:
                    jd_text = content
                elif field == 'resume' and not resume_text and content:
                    resume_text = content
                elif field == 'musthave':
                    musthave_text = content
                elif field == 'prefer':
                    prefer_text = content
                elif field == 'target':
                    if content and content != '[]' and not target_companies:
                        stripped = content.strip('[]').strip()
                        if stripped:
                            target_companies = stripped

            # 将 MustHave / Prefer 拼入 JD（让产品/行业/年限等字段可被正则匹配）
            if musthave_text:
                jd_text = (jd_text or '') + '\n' + musthave_text
            if prefer_text:
                jd_text = (jd_text or '') + '\n【加分项】\n' + prefer_text

            # 兜底: 如果还是没找到
            if not jd_text and not resume_text and len(user_contents) >= 2:
                # 不含 JD 特征的是简历
                for c in user_contents:
                    if not re.search(r'职位名称|工作职责|【职位信息】|职位描述|-\s*职位描述', c):
                        if not resume_text:
                            resume_text = c
                    else:
                        if not jd_text:
                            jd_text = c
            if not jd_text and not resume_text:
                jd_text = raw
                resume_text = raw

            # 策略4: 从 body 的 prompt 字段兜底
            if not jd_text or not resume_text:
                prompt = body.pop("prompt", "")
                if prompt and not jd_text:
                    jd_text = prompt
                if prompt and not resume_text:
                    resume_text = prompt

        # 最终兜底：只要有任意内容就不报错
        if not jd_text and not resume_text:
            raise HTTPException(
                status_code=400,
                detail="多轮打分需要简历和JD内容。请在 messages 中传入，或通过 resume_text/jd_text 字段传入。"
            )
        if not jd_text:
            jd_text = resume_text
        if not resume_text:
            resume_text = jd_text

        # 构建发给 Node.js 的请求体
        mr_body = {
            "jdText": jd_text,
            "resumeText": resume_text,
            "rules": rules_text,
            "targetCompanies": target_companies,
            "temperature": body.get("temperature", 0),
            "max_tokens": min(body.get("max_tokens", 2048), 2048),
        }

        async def multi_round_stream():
            """调用 Node.js 多轮打分，只输出最终结果（不输出中间步骤）"""
            import uuid
            mr_id = "chatcmpl-" + uuid.uuid4().hex[:29]
            created = int(time.time())

            async with request.app.state.http.stream(
                "POST",
                f"{WEB_BASE}/api/score-multi-round",
                json=mr_body,
                headers={"Content-Type": "application/json"},
            ) as mr_resp:
                buffer = ""
                current_event = ""
                final_score = None
                error_msg = None

                async for chunk in mr_resp.aiter_bytes():
                    text = chunk.decode("utf-8", errors="replace")
                    buffer += text

                    while "\n" in buffer:
                        line_end = buffer.index("\n")
                        line = buffer[:line_end].strip()
                        buffer = buffer[line_end + 1:]

                        if line.startswith("event: "):
                            current_event = line[7:]
                        elif line.startswith("data: ") and current_event:
                            try:
                                data = json.loads(line[6:])
                            except Exception:
                                current_event = ""
                                continue

                            if current_event == "done":
                                final_score = data.get("finalScore", {})
                            elif current_event == "error":
                                error_msg = data.get("message", "多轮打分错误")
                            current_event = ""

                # 只输出最终结果（单个 chunk）
                if final_score is not None:
                    final_json = json.dumps(final_score, ensure_ascii=False, indent=2)
                    chunk_data = {
                        "id": mr_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model or "multi-round-scoring",
                        "choices": [{
                            "index": 0,
                            "delta": {"content": final_json},
                            "finish_reason": "stop",
                        }],
                    }
                    yield f"data: {json.dumps(chunk_data, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"
                elif error_msg:
                    chunk_data = {
                        "id": mr_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model or "multi-round-scoring",
                        "choices": [{
                            "index": 0,
                            "delta": {"content": json.dumps({"error": error_msg}, ensure_ascii=False)},
                            "finish_reason": "error",
                        }],
                    }
                    yield f"data: {json.dumps(chunk_data, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"

        is_stream = body.get("stream", False)

        # 记录日志
        duration_ms = (time.time() - start_time) * 1000
        await async_insert_log(
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            client_ip=client_ip,
            method="POST",
            path=full_path,
            request_body=json.dumps({"multi_round": True, "jd_len": len(jd_text), "resume_len": len(resume_text)}, ensure_ascii=False),
            response_body="[Multi-Round Stream]",
            status_code=200,
            duration_ms=round(duration_ms, 2),
            use_scoring_rules=False,
            model=model
        )

        if is_stream:
            return StreamingResponse(
                multi_round_stream(),
                media_type="text/event-stream; charset=utf-8",
                headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
            )
        else:
            # 非流式：收集 SSE 流，提取最终 JSON
            full_content = ""
            async for chunk_text in multi_round_stream():
                for line in chunk_text.split("\n"):
                    if line.startswith("data: ") and not line.startswith("data: [DONE]"):
                        try:
                            chunk_data = json.loads(line[6:])
                            delta = (chunk_data.get("choices", [{}])[0].get("delta", {}) or {}).get("content", "")
                            if delta:
                                full_content += delta
                        except Exception:
                            pass

            # 解析 finalScore
            final_result = None
            try:
                final_result = json.loads(full_content)
            except Exception:
                pass

            mr_id = "chatcmpl-" + str(int(time.time() * 1000))
            return JSONResponse(content={
                "id": mr_id,
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model or "multi-round-scoring",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": full_content,
                    },
                    "finish_reason": "stop",
                }],
                "usage": {
                    "prompt_tokens": len(jd_text + resume_text + rules_text) // 2,
                    "completion_tokens": len(full_content) // 2,
                    "total_tokens": (len(jd_text + resume_text + rules_text) + len(full_content)) // 2,
                },
            })
    # ========== 多轮打分模式结束 ==========

    # 构建简化的请求日志（只保留用户内容，不记录规则）
    log_request = {
        "model": model,
        "max_tokens": body.get("max_tokens"),
        "temperature": body.get("temperature"),
        "stream": body.get("stream", False),
        "use_scoring_rules": use_rules,
        "messages": []
    }

    # 只记录非 system 消息（避免记录规则）
    for msg in messages:
        if msg.get("role") != "system":
            log_request["messages"].append(msg)

    request_body_str = json.dumps(log_request, ensure_ascii=False)

    if use_rules:
        rules_config = load_scoring_rules()
        if "error" in rules_config:
            raise HTTPException(status_code=500, detail=f"规则加载失败: {rules_config['error']}")

        body["messages"] = inject_rules_into_messages(messages, rules_config)

    # 判断是否流式
    is_stream = body.get("stream", False)
    # 限制 max_tokens 不超过 2048（适配 max-model-len=12288）
    if body.get("max_tokens", 0) > 2048:
        body["max_tokens"] = 2048
    # 禁用 Qwen3 的 thinking 模式（SGLang 会输出 <think> 标签破坏 JSON 解析）
    if "chat_template_kwargs" not in body:
        body["chat_template_kwargs"] = {}
    body["chat_template_kwargs"]["enable_thinking"] = False
    body_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")

    headers = dict(request.headers)

    if is_stream:
        # 流式响应暂不记录响应内容
        duration_ms = (time.time() - start_time) * 1000
        await async_insert_log(
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            client_ip=client_ip,
            method="POST",
            path=full_path,
            request_body=request_body_str[:10000],
            response_body="[Stream Response]",
            status_code=200,
            duration_ms=round(duration_ms, 2),
            use_scoring_rules=use_rules,
            model=model
        )
        return await proxy_stream_to_vllm(request.app.state.http, "POST", full_path, body_bytes, headers)
    else:
        forward_headers = {}
        for key, value in headers.items():
            lower = key.lower()
            if lower not in ("host", "content-length", "transfer-encoding"):
                forward_headers[key] = value

        resp = await request.app.state.http.request(
            method="POST",
            url=f"{VLLM_BASE}{full_path}",
            content=body_bytes,
            headers=forward_headers,
        )

        duration_ms = (time.time() - start_time) * 1000

        # 解析响应
        try:
            resp_json = resp.json()
            # 安全兜底：剔除 Qwen3 可能输出的 <think>...</think> 标签
            choices = resp_json.get("choices", [])
            for c in choices:
                msg = c.get("message", {})
                content = msg.get("content", "")
                if isinstance(content, str) and "<think>" in content:
                    # 移除 <think>...</think> 块及其变体
                    content = re.sub(r'<think>.*?</think>\s*', '', content, flags=re.DOTALL)
                    msg["content"] = content
            resp_body_str = json.dumps(resp_json, ensure_ascii=False)
            # 提取 token 使用信息
            usage = resp_json.get("usage", {})
            prompt_tokens = usage.get("prompt_tokens")
            completion_tokens = usage.get("completion_tokens")
        except:
            resp_body_str = resp.text
            prompt_tokens = None
            completion_tokens = None

        # 记录日志
        await async_insert_log(
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            client_ip=client_ip,
            method="POST",
            path=full_path,
            request_body=request_body_str[:10000],
            response_body=resp_body_str[:10000],
            status_code=resp.status_code,
            duration_ms=round(duration_ms, 2),
            use_scoring_rules=use_rules,
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens
        )

        try:
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
        except Exception:
            return JSONResponse(content={"error": resp.text}, status_code=resp.status_code)


# ========== 兼容 OpenAI SDK 的其他路径 ==========
@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def catch_all(request: Request, path: str):
    """兜底：其他所有请求透传到 vLLM"""
    # 排除已处理的 API 路径
    if path.startswith("api/scoring-rules") or path.startswith("api/logs") or path.startswith("api/score-multi-round"):
        raise HTTPException(status_code=404, detail="Not Found")

    full_path = f"/{path}" if path else "/"
    resp = await proxy_to_vllm(request.method, full_path, request)

    try:
        return JSONResponse(content=resp.json(), status_code=resp.status_code)
    except Exception:
        return JSONResponse(content={"text": resp.text}, status_code=resp.status_code)


# ========== 启动 ==========
if __name__ == "__main__":
    print(f"🚀 Rules Injection Proxy starting on port {PROXY_PORT}")
    print(f"📡 vLLM backend: {VLLM_BASE}")
    print(f"📋 Scoring rules file: {RULES_FILE}")

    # 验证规则文件
    rules = load_scoring_rules()
    if "error" in rules:
        print(f"⚠️  Scoring rules: {rules['error']}")
    else:
        print(f"✅ Scoring rules loaded (v{rules.get('version', '?')}, {len(rules.get('rules', ''))} chars)")

    uvicorn.run("rules_proxy:app", host="0.0.0.0", port=PROXY_PORT, log_level="info", workers=2)
