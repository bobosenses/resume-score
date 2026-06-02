# 简历智能打分系统

基于 **vLLM + Qwen3-8B-FP8** 的简历智能打分系统，集成 RAG 语义检索、打分规则热加载、多轮对话等功能。

## 功能特性

- 🎯 **简历智能打分** — 输入简历 + JD，自动按规则评分并输出结构化结果
- 💭 **思考模式** — 可切换深度推理模式，提升复杂任务的评分质量
- 📋 **打分规则热加载** — 修改规则文件或通过 API/页面更新，无需重启服务
- 🔍 **RAG 语义检索** — 集成 bge-m3 Embedding + bge-reranker 精排的向量检索
- 🌐 **Web 管理界面** — 简历打分 + AI Chat + 系统设置三合一页面
- ⚡ **高性能推理** — vLLM 连续批处理，A10 GPU 支持 30+ 并发

## 系统架构

```
外部调用者 / 浏览器
    │
    ├─── :8000 ──→ Rules Proxy ──→ :8003 ──→ vLLM (Qwen3-8B-FP8)
    │    注入打分规则              模型推理
    │
    ├─── :3000 ──→ Web 前端 (Node.js)
    │    简历打分 + AI Chat + 系统设置
    │
    ├─── :8001 ──→ ChromaDB 向量数据库
    │
    └─── :8002 ──→ RAG API (Embedding + Rerank)
```

## 项目结构

```
├── rules_proxy.py          # Rules Injection Proxy（端口 8000）
├── log_db.py                # 请求日志数据库模块（SQLite）
├── chromadb_api.py          # RAG 语义检索 API（端口 8002）
├── chromadb_service.py      # ChromaDB 使用示例
├── config/
│   └── scoring_rules.json   # 打分规则（热加载，改文件即生效）
├── web/
│   ├── server.js            # Web 服务端（端口 3000）
│   ├── index.html           # 前端页面
│   ├── logs.html            # 请求日志查看页面
│   ├── benchmark.html       # 压测报告仪表盘
│   └── 123.txt              # 默认测试用例
├── logs/
│   └── request_logs.db      # 请求日志数据库（自动生成，不上传）
├── knowledge_base/
│   └── knowledge_base.csv   # 知识库样本数据
├── test_cases.json          # 测试用例（3份简历+JD+规则）
├── test_scoring.py          # 自动化测试脚本
├── start_all.sh             # 一键启动所有服务
├── stop_all.sh              # 一键停止所有服务
├── requirements.txt         # Python 依赖
├── API.md                   # 接口调用文档
└── README.md                # 本文件
```

## 快速开始

### 1. 环境要求

- **操作系统**: Ubuntu 22.04+
- **GPU**: NVIDIA A10 23GB（或同等显存以上）
- **CUDA**: 12.8+
- **Node.js**: >= 18
- **Python**: >= 3.10

### 2. 下载模型

```bash
# 创建模型目录
mkdir -p models

# 下载 Qwen3-8B-FP8（LLM 推理，约 8.8GB）
pip install huggingface-hub
HF_ENDPOINT=https://hf-mirror.com huggingface-cli download Qwen/Qwen3-8B-FP8 --local-dir models/Qwen3-8B-FP8

# 下载 bge-m3（Embedding，约 4.3GB）
HF_ENDPOINT=https://hf-mirror.com huggingface-cli download BAAI/bge-m3 --local-dir models/bge-m3 --exclude 'imgs/*'

# 下载 bge-reranker-v2-m3（Rerank，约 2.2GB）
HF_ENDPOINT=https://hf-mirror.com huggingface-cli download BAAI/bge-reranker-v2-m3 --local-dir models/bge-reranker-v2-m3
```

**模型下载地址：**

| 模型 | HuggingFace | 用途 | 大小 |
|------|-------------|------|------|
| Qwen3-8B-FP8 | [Qwen/Qwen3-8B-FP8](https://huggingface.co/Qwen/Qwen3-8B-FP8) | LLM 推理 | 8.8GB |
| bge-m3 | [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) | 文本向量化 | 4.3GB |
| bge-reranker-v2-m3 | [BAAI/bge-reranker-v2-m3](https://huggingface.co/BAAI/bge-reranker-v2-m3) | 搜索结果精排 | 2.2GB |

> 国内下载可使用镜像：`HF_ENDPOINT=https://hf-mirror.com`

### 3. 安装依赖

```bash
# 创建 Python 虚拟环境
python3 -m venv venv
source venv/bin/activate

# 安装 Python 依赖
pip install -r requirements.txt
```

### 4. 一键启动

```bash
bash start_all.sh
```

启动顺序：vLLM (8003) → Rules Proxy (8000) → Web (3000) → ChromaDB (8001) → RAG API (8002)

等待约 2 分钟（vLLM 加载模型），看到「所有服务启动完成」即可访问：

- **Web 界面**: http://localhost:3000/
- **LLM API**: http://localhost:8000/v1/
- **RAG API**: http://localhost:8002/

### 5. 一键停止

```bash
bash stop_all.sh
```

## 使用方式

### Web 页面

打开 http://localhost:3000/，三个 Tab：

| Tab | 功能 |
|-----|------|
| 简历打分 | 输入简历 + JD，自动评分（流式输出） |
| AI Chat | 多轮对话，支持思考模式 |
| ⚙️ 系统设置 | 思考模式开关、模型参数、打分规则编辑 |

### API 调用 — 简历打分

```bash
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen3-8B-FP8",
    "messages": [
      {"role": "user", "content": "=== 候选人简历 ===\n张三，10年AI产品经验...\n\n=== JD ===\n高级AI产品经理..."}
    ],
    "max_tokens": 2000,
    "use_scoring_rules": true
  }'
```

`use_scoring_rules: true` — 服务器自动注入打分规则，无需在请求中传递规则内容。

### API 调用 — 普通对话

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="not-needed")
resp = client.chat.completions.create(
    model="Qwen/Qwen3-8B-FP8",
    messages=[{"role": "user", "content": "你好"}],
    max_tokens=200,
)
print(resp.choices[0].message.content)
```

### API 调用 — RAG 语义检索

```python
import requests

# 添加文档
requests.post("http://localhost:8002/documents/add", json={
    "collection": "knowledge_base",
    "documents": ["vLLM 是一个高性能推理引擎"],
})

# 检索
resp = requests.post("http://localhost:8002/search", json={
    "query": "什么是推理引擎",
    "rerank": True,
})
print(resp.json())
```

### 打分规则管理

**文件热加载：**

```bash
# 直接编辑，下次请求自动生效
vim config/scoring_rules.json
```

**API 更新：**

```bash
curl -X PUT http://localhost:8000/api/scoring-rules \
  -H "Content-Type: application/json" \
  -d '{"rules": "新的打分规则...", "version": "2.0"}'
```

**页面管理：**

打开 http://localhost:3000/ → ⚙️ 系统设置 → ✏️ 编辑 → 修改规则 → 💾 保存

### 思考模式

```bash
# 开启思考模式（模型先推理再回答）
curl -X POST http://localhost:8000/v1/chat/completions \
  -d '{"messages": [...], "chat_template_kwargs": {"enable_thinking": true}}'
```

在 Web 页面中，通过「⚙️ 系统设置」Tab 的开关全局控制。

## 端口说明

| 端口 | 服务 | 公网 |
|------|------|------|
| 8000 | Rules Proxy（LLM 入口） | ✅ |
| 8001 | ChromaDB | ✅ |
| 8002 | RAG API | ✅ |
| 8003 | vLLM（内部） | ❌ |
| 3000 | Web 前端 | ✅ |

## 并发能力（NVIDIA A10 23GB）

| 并发数 | KV Cache | 说明 |
|--------|----------|------|
| 10 | ~35% | 轻松 |
| 30 | ~60% | 正常 |
| 50 | ~99.8% | 极限 |

## 测试

```bash
# 激活虚拟环境
source venv/bin/activate

# 测试所有简历
python3 test_scoring.py --api web

# 开启思考模式测试
python3 test_scoring.py --api web --thinking

# 对比测试
python3 test_scoring.py --compare
```

## 日志

```bash
tail -f vllm.log        # vLLM 日志
tail -f proxy.log       # Rules Proxy 日志
tail -f web.log         # Web 服务日志
```

## 请求日志系统

系统自动记录每次 API 请求的详细信息，支持 Web 界面查看和筛选。

### 功能特性

- 📊 **统计面板** — 总请求数、成功率、平均耗时、打分规则使用数
- 🔍 **多维筛选** — 时间范围、IP 地址、HTTP 状态码、关键字搜索
- 📋 **详情查看** — 点击查看完整的请求/响应内容
- 🔄 **自动刷新** — 每 30 秒自动刷新数据
- 💾 **SQLite 存储** — 轻量级数据库，无需额外服务

### 记录字段

| 字段 | 说明 |
|------|------|
| timestamp | 请求时间 |
| client_ip | 客户端 IP |
| method | HTTP 方法 |
| path | 请求路径 |
| request_body | 请求内容（自动过滤规则，只记录用户消息） |
| response_body | 响应内容 |
| status_code | HTTP 状态码 |
| duration_ms | 请求耗时（毫秒） |
| use_scoring_rules | 是否使用打分规则 |
| model | 模型名称 |
| prompt_tokens | 输入 Token 数 |
| completion_tokens | 输出 Token 数 |

### 访问方式

- **Web 页面**: http://localhost:3000/logs
- **日志 API**: `GET /api/logs?page=1&page_size=20`
- **统计 API**: `GET /api/logs/stats/summary?hours=24`
- **详情 API**: `GET /api/logs/{id}`

### API 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| start_time | string | 开始时间 (YYYY-MM-DD HH:MM:SS) |
| end_time | string | 结束时间 (YYYY-MM-DD HH:MM:SS) |
| client_ip | string | 按 IP 筛选 |
| status_code | int | 按状态码筛选 |
| use_scoring_rules | bool | 按是否使用规则筛选 |
| keyword | string | 关键字搜索（请求/响应内容） |
| page | int | 页码（默认 1） |
| page_size | int | 每页数量（默认 20，最大 100） |

### 数据存储

日志存储在 `logs/request_logs.db`（SQLite），该目录已添加到 `.gitignore`，不会上传到 GitHub。

如需备份日志：
```bash
cp logs/request_logs.db logs/backup_$(date +%Y%m%d).db
```

## License

MIT
