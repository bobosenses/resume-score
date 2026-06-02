#!/usr/bin/env python3
"""
Rules Injection Proxy for vLLM
- 监听端口 8000，将请求转发到 vLLM（端口 8001）
- 对 /v1/chat/completions 请求，当 use_scoring_rules=true 时自动注入打分规则
- 打分规则从 /root/vLLM/config/scoring_rules.json 实时读取（热加载）
- 提供规则管理 API：GET/PUT /api/scoring-rules
"""

import json
import os
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# ========== 配置 ==========
BASE_DIR = Path(__file__).parent
VLLM_BASE = os.getenv("VLLM_BASE", "http://127.0.0.1:8003")
PROXY_PORT = int(os.getenv("PROXY_PORT", "8000"))
RULES_FILE = os.getenv("RULES_FILE", str(BASE_DIR / "config" / "scoring_rules.json"))

app = FastAPI(title="Rules Injection Proxy", version="1.0.0")

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

    async with httpx.AsyncClient(timeout=600.0) as client:
        resp = await client.request(
            method=method,
            url=url,
            content=body,
            headers=headers,
        )
    return resp


async def proxy_stream_to_vllm(method: str, path: str, body: bytes, headers: dict):
    """流式代理到 vLLM — client 生命周期绑定在 generator 内，避免 StreamClosed"""
    url = f"{VLLM_BASE}{path}"

    forward_headers = {}
    for key, value in headers.items():
        lower = key.lower()
        if lower not in ("host", "content-length", "transfer-encoding"):
            forward_headers[key] = value

    async def generate():
        async with httpx.AsyncClient(timeout=600.0) as client:
            async with client.stream(
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
async def health():
    """健康检查"""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{VLLM_BASE}/health")
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

    # 非 chat/completions 请求直接透传
    if path != "chat/completions" or request.method != "POST":
        resp = await proxy_to_vllm(request.method, full_path, request)
        return JSONResponse(
            content=resp.json() if resp.headers.get("content-type", "").startswith("application/json") else resp.text,
            status_code=resp.status_code,
        )

    # chat/completions 请求：检查是否需要注入规则
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="无效的 JSON")

    use_rules = body.pop("use_scoring_rules", False)

    if use_rules:
        rules_config = load_scoring_rules()
        if "error" in rules_config:
            raise HTTPException(status_code=500, detail=f"规则加载失败: {rules_config['error']}")

        messages = body.get("messages", [])
        body["messages"] = inject_rules_into_messages(messages, rules_config)

    # 判断是否流式
    is_stream = body.get("stream", False)
    body_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")

    headers = dict(request.headers)

    if is_stream:
        return await proxy_stream_to_vllm("POST", full_path, body_bytes, headers)
    else:
        async with httpx.AsyncClient(timeout=600.0) as client:
            forward_headers = {}
            for key, value in headers.items():
                lower = key.lower()
                if lower not in ("host", "content-length", "transfer-encoding"):
                    forward_headers[key] = value

            resp = await client.request(
                method="POST",
                url=f"{VLLM_BASE}{full_path}",
                content=body_bytes,
                headers=forward_headers,
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
    if path.startswith("api/scoring-rules"):
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

    uvicorn.run(app, host="0.0.0.0", port=PROXY_PORT, log_level="info")
