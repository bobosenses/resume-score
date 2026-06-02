# API 接口调用文档

> **服务器地址**：`8.163.39.222`
> 
> **最后更新**：2026-05-31

---

## 快速参考

| 服务 | 端口 | Base URL | 用途 |
|------|------|----------|------|
| **Rules Proxy + vLLM** | 8000 | `http://8.163.39.222:8000/v1` | LLM 推理（OpenAI 兼容），支持服务端打分规则注入 |
| **RAG 语义检索** | 8002 | `http://8.163.39.222:8002` | Embedding + Rerank 检索 |
| **Web 服务** | 3000 | `http://8.163.39.222:3000` | 简历打分 + Chat（封装层） |
| **ChromaDB** | 8001 | `http://8.163.39.222:8001` | 向量数据库原生 API |

> **推荐使用顺序**：端口 8000 做对话推理/简历打分（`use_scoring_rules: true` 自动注入规则）→ RAG API (8002) 做知识库检索 → 两者组合实现 RAG

---

## 一、vLLM 推理引擎（端口 8000）

完全兼容 **OpenAI API**，可直接使用 `openai` SDK 或 `requests` 调用。

### 1.1 健康检查

```bash
curl http://8.163.39.222:8000/v1/models
```

### 1.2 对话补全（非流式）

```bash
curl -X POST http://8.163.39.222:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "/root/vLLM/models/Qwen3-8B-FP8",
    "messages": [{"role": "user", "content": "你好，请用一句话介绍自己"}],
    "max_tokens": 200,
    "temperature": 0.1,
    "stream": false
  }'
```

**响应：**
```json
{
  "id": "chatcmpl-xxx",
  "model": "/root/vLLM/models/Qwen3-8B-FP8",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "你好！我是通义千问，由阿里巴巴研发的大语言模型..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 42,
    "total_tokens": 57
  }
}
```

### 1.3 对话补全（流式）

```bash
curl -N -X POST http://8.163.39.222:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "/root/vLLM/models/Qwen3-8B-FP8",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 200,
    "stream": true
  }'
```

**流式响应**（SSE 格式，每行 `data: {...}`，结束时 `data: [DONE]`）：
```
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"role":"assistant","content":"你"},"index":0}]}
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"好"},"index":0}]}
data: {"id":"chatcmpl-xxx","choices":[{"delta":{},"finish_reason":"stop","index":0}]}
data: [DONE]
```

### 1.4 思考模式（enable_thinking）

通过 `chat_template_kwargs.enable_thinking` 控制：

```bash
# 开启思考模式
curl -X POST http://8.163.39.222:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "/root/vLLM/models/Qwen3-8B-FP8",
    "messages": [{"role": "user", "content": "9.11和9.8哪个大？请详细分析"}],
    "max_tokens": 1000,
    "stream": false,
    "chat_template_kwargs": {"enable_thinking": true}
  }'
```

开启后输出的 `content` 中会包含 `<think>思考过程</think>最终答案`，需自行解析分离。

**参数对照表：**

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| model | string | 必填 | `/root/vLLM/models/Qwen3-8B-FP8` |
| messages | array | 必填 | OpenAI 消息格式 |
| max_tokens | int | - | 最大输出 token 数 |
| temperature | float | 1.0 | 采样温度（0~2） |
| top_p | float | 1.0 | 核采样 |
| stream | bool | false | 是否流式输出 |
| chat_template_kwargs.enable_thinking | bool | false | **思考模式开关** |

### 1.5 简历打分（服务端规则注入）

打分规则存储在服务器端（`/root/vLLM/config/scoring_rules.json`），调用时只需传简历和 JD，加上 `use_scoring_rules: true` 即可自动注入规则。**修改规则文件即刻生效，无需重启服务。**

```bash
curl -X POST http://8.163.39.222:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "/root/vLLM/models/Qwen3-8B-FP8",
    "messages": [
      {"role": "user", "content": "=== 候选人简历 ===\n姓名：张三\n...\n\n=== 职位描述(JD) ===\n高级产品经理 - AI应用方向\n..."}
    ],
    "max_tokens": 2000,
    "stream": false,
    "use_scoring_rules": true
  }'
```

**参数说明：**

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| use_scoring_rules | bool | false | **设为 true 时自动注入服务端打分规则** |

> 当 `use_scoring_rules` 为 `true` 时，代理会在 messages 最前面自动插入包含打分规则的 system 消息，调用者无需传递规则内容。不带此参数或设为 `false` 时，请求原样透传。

### 1.6 打分规则管理

**查看当前规则：**
```bash
curl http://8.163.39.222:8000/api/scoring-rules
```

**响应：**
```json
{
  "version": "1.0",
  "updated_at": "2026-05-31T10:00:00+08:00",
  "description": "AI产品经理简历打分规则 - 服务端热加载",
  "enabled": true,
  "system_prompt": "你是一位资深HR和技术面试官...",
  "rules_preview": "【简历打分规则 - 高级AI产品经理岗位】...",
  "rules_length": 2859
}
```

**更新规则（热生效）：**
```bash
curl -X PUT http://8.163.39.222:8000/api/scoring-rules \
  -H "Content-Type: application/json" \
  -d '{
    "rules": "新的打分规则文本...",
    "system_prompt": "你是一位资深HR...",
    "version": "1.1"
  }'
```

**响应：**
```json
{
  "message": "规则更新成功",
  "version": "1.1",
  "updated_at": "2026-05-31T10:30:00+08:00",
  "rules_length": 3000
}
```

**验证规则加载：**
```bash
curl -X POST http://8.163.39.222:8000/api/scoring-rules/reload
```

> 也可以直接在服务器上编辑 `/root/vLLM/config/scoring_rules.json`，下次请求即刻生效。

### 1.7 文本补全

```bash
curl -X POST http://8.163.39.222:8000/v1/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "/root/vLLM/models/Qwen3-8B-FP8",
    "prompt": "中国的首都是",
    "max_tokens": 50
  }'
```

---

## 二、RAG 语义检索 API（端口 8002）

集成 **bge-m3 Embedding** + **bge-reranker-v2-m3 Rerank** + **ChromaDB** 的一站式检索服务。

Swagger 文档：http://8.163.39.222:8002/docs

### 2.1 健康检查

```bash
curl http://8.163.39.222:8002/health
```

**响应：**
```json
{"status": "ok", "chromadb": "connected"}
```

### 2.2 列出所有集合

```bash
curl http://8.163.39.222:8002/collections
```

**响应：**
```json
{"collections": [{"name": "knowledge_base", "count": 5}]}
```

### 2.3 创建集合

```bash
curl -X POST http://8.163.39.222:8002/collections/my_collection
```

### 2.4 删除集合

```bash
curl -X DELETE http://8.163.39.222:8002/collections/my_collection
```

### 2.5 添加文档（自动 Embedding 向量化）

```bash
curl -X POST http://8.163.39.222:8002/documents/add \
  -H "Content-Type: application/json" \
  -d '{
    "collection": "knowledge_base",
    "documents": [
      "vLLM 是一个高性能推理引擎，支持 PagedAttention",
      "ChromaDB 是一个开源的向量数据库",
      "BGE-M3 支持稠密检索、稀疏检索和 ColBERT 多向量检索"
    ],
    "metadatas": [
      {"source": "docs", "category": "inference"},
      {"source": "docs", "category": "database"},
      {"source": "docs", "category": "embedding"}
    ]
  }'
```

**响应：**
```json
{"message": "已添加 3 条文档", "collection": "knowledge_base", "total": 8}
```

**参数说明：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| collection | string | 否 | 集合名，默认 `knowledge_base` |
| documents | string[] | 是 | 文档文本列表 |
| metadatas | object[] | 否 | 每条文档对应的元数据 |
| ids | string[] | 否 | 文档 ID，不填则自动生成 |

### 2.6 语义检索 + Rerank

```bash
curl -X POST http://8.163.39.222:8002/search \
  -H "Content-Type: application/json" \
  -d '{
    "collection": "knowledge_base",
    "query": "什么是向量数据库",
    "top_k": 10,
    "rerank": true,
    "rerank_top_k": 5
  }'
```

**响应：**
```json
{
  "query": "什么是向量数据库",
  "results": [
    {
      "id": "doc_xxx",
      "document": "ChromaDB 是一个开源的向量数据库，用于存储和查询文本的向量表示。",
      "metadata": {"category": "database", "source": "docs"},
      "score": 0.34,
      "rerank_score": 0.83
    }
  ],
  "total": 1,
  "elapsed_ms": 289.8
}
```

**参数说明：**

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| collection | string | 否 | `knowledge_base` | 集合名 |
| query | string | 是 | - | 查询文本 |
| top_k | int | 否 | 10 | Embedding 初检返回数 |
| rerank | bool | 否 | true | 是否启用 Rerank 精排 |
| rerank_top_k | int | 否 | 5 | Rerank 后返回数 |

**结果字段：**

| 字段 | 说明 |
|------|------|
| score | Embedding 向量相似度（cosine distance 取反） |
| rerank_score | Cross-Encoder 精排分数，**主要参考指标** |
| elapsed_ms | 检索总耗时（毫秒） |

### 2.7 查询集合文档数

```bash
curl http://8.163.39.222:8002/collections/knowledge_base/count
```

**响应：**
```json
{"name": "knowledge_base", "count": 8}
```

---

## 三、Web 服务接口（端口 3000）

封装了 vLLM 调用，额外支持简历打分场景。

### 3.1 单次生成（/api/generate）

```bash
curl -N -X POST http://8.163.39.222:3000/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "用一段话评价这份简历...",
    "stream": true,
    "thinking": true,
    "options": {
      "temperature": 0.1,
      "num_predict": 600
    }
  }'
```

**流式响应**（ndjson，每行一个 JSON）：
```json
{"model":"...","response":"这","done":false}
{"model":"...","response":"是一份","done":false}
{"model":"...","response":"","done":true,"eval_count":128,"eval_duration":0,"prompt_eval_count":500}
```

**参数说明：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| prompt | string | 是 | 完整 prompt 文本 |
| model | string | 否 | 模型路径，可不填 |
| stream | bool | 否 | 是否流式，默认 true |
| thinking | bool | 否 | 思考模式，默认 false |
| options.temperature | float | 否 | 采样温度，默认 0.1 |
| options.num_predict | int | 否 | 最大输出 token，默认 600 |

### 3.2 多轮对话（/api/chat）

```bash
curl -N -X POST http://8.163.39.222:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "你好"},
      {"role": "assistant", "content": "你好！有什么可以帮你的？"},
      {"role": "user", "content": "讲个笑话"}
    ],
    "thinking": false,
    "temperature": 0.1,
    "max_tokens": 600
  }'
```

**流式响应**（ndjson）：
```json
{"model":"...","message":{"role":"assistant","content":"好"},"done":false}
{"model":"...","message":{"role":"assistant","content":"的"},"done":false}
{"model":"...","message":{"role":"assistant","content":""},"done":true}
```

### 3.3 获取默认测试用例

```bash
curl http://8.163.39.222:3000/api/default-test-case
```

**响应：**
```json
{
  "resume": "简历文本...",
  "jd": "JD文本...",
  "rules": "打分规则...",
  "resumeChars": 1572,
  "jdChars": 2187,
  "rulesChars": 7436
}
```

---

## 四、Python 调用示例

### 4.1 简历打分（服务端规则注入）

```python
import requests

# 只需传简历和 JD，打分规则由服务器自动注入
resp = requests.post(
    "http://8.163.39.222:8000/v1/chat/completions",
    json={
        "model": "/root/vLLM/models/Qwen3-8B-FP8",
        "messages": [
            {"role": "user", "content": "=== 候选人简历 ===\n姓名：张三\n...\n\n=== 职位描述(JD) ===\n..."}
        ],
        "max_tokens": 2000,
        "use_scoring_rules": True,  # 自动注入服务端打分规则
    },
)
print(resp.json()["choices"][0]["message"]["content"])
```

### 4.2 用 openai SDK 调用 vLLM（推荐）

```python
from openai import OpenAI

# 初始化客户端（指向远程服务器）
client = OpenAI(
    base_url="http://8.163.39.222:8000/v1",
    api_key="not-needed",
)

# 普通对话
resp = client.chat.completions.create(
    model="/root/vLLM/models/Qwen3-8B-FP8",
    messages=[{"role": "user", "content": "你好"}],
    max_tokens=200,
    temperature=0.1,
)
print(resp.choices[0].message.content)

# 开启思考模式
resp = client.chat.completions.create(
    model="/root/vLLM/models/Qwen3-8B-FP8",
    messages=[{"role": "user", "content": "9.11和9.8哪个大？"}],
    max_tokens=1000,
    extra_body={"chat_template_kwargs": {"enable_thinking": True}},
)
# 解析思考过程和最终答案
import re
content = resp.choices[0].message.content
match = re.search(r"<think>(.*?)</think>(.*)", content, re.DOTALL)
if match:
    thinking = match.group(1).strip()
    answer = match.group(2).strip()
    print(f"思考过程：{thinking[:200]}...")
    print(f"最终答案：{answer}")
else:
    print(content)
```

### 4.3 用 openai SDK 流式调用

```python
stream = client.chat.completions.create(
    model="/root/vLLM/models/Qwen3-8B-FP8",
    messages=[{"role": "user", "content": "写一首关于春天的诗"}],
    max_tokens=200,
    stream=True,
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
```

### 4.4 用 requests 调用 vLLM

```python
import requests

resp = requests.post(
    "http://8.163.39.222:8000/v1/chat/completions",
    json={
        "model": "/root/vLLM/models/Qwen3-8B-FP8",
        "messages": [{"role": "user", "content": "你好"}],
        "max_tokens": 200,
        "stream": False,
    },
)
print(resp.json()["choices"][0]["message"]["content"])
```

### 4.5 用 requests 调用 RAG 检索

```python
import requests

RAG_BASE = "http://8.163.39.222:8002"

# 添加文档
resp = requests.post(f"{RAG_BASE}/documents/add", json={
    "collection": "knowledge_base",
    "documents": [
        "vLLM 支持 PagedAttention 和连续批处理",
        "FP8 量化可以减少模型显存占用",
    ],
    "metadatas": [
        {"source": "docs"},
        {"source": "docs"},
    ],
})
print(resp.json())

# 语义检索
resp = requests.post(f"{RAG_BASE}/search", json={
    "collection": "knowledge_base",
    "query": "如何减少显存占用",
    "top_k": 5,
    "rerank": True,
    "rerank_top_k": 3,
})
for r in resp.json()["results"]:
    print(f"[{r['rerank_score']:.4f}] {r['document']}")
```

### 4.6 完整 RAG 流程（检索 + 生成）

```python
import requests

RAG_BASE = "http://8.163.39.222:8002"
VLLM_URL = "http://8.163.39.222:8000/v1/chat/completions"
MODEL = "/root/vLLM/models/Qwen3-8B-FP8"

def rag_query(question: str, top_k: int = 3) -> str:
    """完整的 RAG 流程：先检索知识库，再用检索结果生成回答"""
    
    # Step 1: 语义检索
    search_resp = requests.post(f"{RAG_BASE}/search", json={
        "query": question,
        "rerank": True,
        "rerank_top_k": top_k,
    })
    docs = search_resp.json().get("results", [])
    
    if not docs:
        context = "（知识库中未找到相关信息）"
    else:
        context = "\n".join(
            f"[{i+1}] {d['document']} (相关度: {d['rerank_score']:.2f})"
            for i, d in enumerate(docs)
        )
    
    # Step 2: 构建 prompt 并调用 LLM
    prompt = f"""基于以下参考资料回答问题。如果资料不足以回答，请说明。

参考资料：
{context}

问题：{question}"""

    llm_resp = requests.post(VLLM_URL, json={
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "你是一个知识库助手，基于提供的参考资料准确回答问题。"},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 500,
        "temperature": 0.1,
    })
    
    return llm_resp.json()["choices"][0]["message"]["content"]

# 使用示例
answer = rag_query("vLLM 有什么特性？")
print(answer)
```

### 4.7 用 requests 流式调用 Web 服务（/api/generate）

```python
import requests
import json

resp = requests.post(
    "http://8.163.39.222:3000/api/generate",
    json={
        "prompt": "请用一句话介绍自己",
        "stream": True,
        "thinking": True,
        "options": {"temperature": 0.1, "num_predict": 300},
    },
    stream=True,
)

full_text = ""
for line in resp.iter_lines():
    if line:
        data = json.loads(line)
        if data.get("response"):
            full_text += data["response"]
            print(data["response"], end="", flush=True)

print(f"\n\n总输出: {len(full_text)} 字符")
```

---

## 五、错误处理

所有接口返回标准 HTTP 状态码：

| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 400 | 请求参数错误（JSON 格式错误、缺少必填字段） |
| 404 | 资源不存在（集合不存在、文件未找到） |
| 500 | 服务器内部错误（vLLM 未启动、模型加载失败） |

**错误响应示例：**
```json
{"error": "Invalid JSON"}
{"error": "报告文件未找到，请先运行压测"}
```

---

## 六、注意事项

1. **思考模式**：开启后 token 消耗增加 3-5 倍，响应时间增加 3-5 倍，仅复杂推理任务使用
2. **流式输出**：长文本建议使用 `stream: true`，避免超时
3. **Token 限制**：vLLM 默认 `max_model_len=32768`，超长文本需分块处理
4. **Rerank 分数**：RAG 检索结果以 `rerank_score` 为准，`score` 仅为初筛参考
5. **安全提醒**：当前接口无认证，生产环境需配合安全组或 Nginx 做访问控制
