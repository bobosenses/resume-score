# 简历智能打分系统

基于 **vLLM + Qwen3-8B-AWQ** 的简历智能打分系统。围绕 `scoring_rules.json v3.0` 的 Layer0/Layer1 闸门模型，集成自适应限流网关、RAG 语义检索、规则热加载、监控聚合等模块。

## 功能特性

- **分层打分（Layered Scoring）** — Layer0 四维门槛 + Layer1 硬性约束 + Layer2 加分 + Layer3 扣分；不满足闸门直接低分熔断
- **主经历判定** — 篇幅/时长/角色三准则任二满足即视为主经历，非主经历自动封顶 10 分
- **年限 ±1 容忍** — JD 年限要求允许 ±1 年浮动，边界差距轻扣 3 分，避免一刀切误杀
- **规则热加载** — `config/scoring_rules.json` 改文件即生效，也可通过 API/页面更新
- **自适应限流** — Throttle Gateway 根据 vLLM 健康度动态调整 capacity，503 快速失败
- **RAG 检索** — bge-m3 Embedding + bge-reranker-v2-m3 精排
- **Web 管理界面** — 简历打分、AI Chat、监控、设置一体化
- **请求日志** — SQLite 持久化，支持多维筛选与详情查看

## 系统架构

```
浏览器 / 外部调用
    │
    ├─ :3000  Web 前端 (Node.js)
    │         └─ /api/score-layered  ──┐
    │                                  │
    ├─ :3100  Throttle Gateway   ←─────┘   自适应限流, 503 fail-fast
    │         │
    │         └─→ :3000 内部回环 → vLLM
    │
    ├─ :3101  Monitor API              聚合 throttle + vllm + sqlite
    │
    ├─ :8000  Rules Proxy        →  :8003  vLLM (Qwen3-8B-AWQ)
    │         注入打分规则
    │
    ├─ :8001  ChromaDB
    └─ :8002  RAG API (Embedding + Rerank)
```

## 打分规则架构（scoring_rules.json v3.0）

四层模型，自上而下：

| 层 | 名称 | 作用 |
|----|------|------|
| Layer0 | 四维门槛 | 行业/产品/职能/年限任一 < 70 分 → 总分按门槛分计算 |
| Layer1 | 硬性约束 | 学历/经验/产品/职能 Mismatch → 总分封顶 30 分 |
| Layer2 | 加分项 | 主经历命中加权、稀缺产品加分等 |
| Layer3 | 扣分项 | Must 项缺失 ×3 分、跳槽频繁等 |

**主经历判定**：候选某段经历占简历篇幅 ≥50% / 时长 ≥60% / 担任核心角色，三准则中任二满足即视为主经历。非主经历总分上限 10 分，边缘经历计 0 分。

**年限容忍**：JD 要求 `minExp` ~ `maxExp` 年。`expGap ≤ 1` 且 `expOverGap ≤ 1` 视为达标（边界轻扣 3 分）；`expGap ≥ 3` 扣 20 分。

详情见 `docs/four_round_scoring_spec.md`。

## 项目结构

```
├── rules_proxy.py              # Rules Injection Proxy (8000)
├── chromadb_api.py             # RAG API (8002)
├── log_db.py                   # 请求日志 SQLite 模块
├── config/
│   └── scoring_rules.json      # 打分规则 v3.0 (热加载)
├── throttle/
│   ├── gateway.js              # Throttle Gateway (3100)
│   └── monitor_api.js          # Monitor API (3101)
├── web/
│   ├── server.js               # Web 服务端 (3000)
│   │                           # 含 /api/score-layered 分层打分接口
│   ├── index.html              # 主页面
│   ├── monitor.html            # 实时监控
│   ├── logs.html               # 请求日志
│   └── benchmark.html          # 压测仪表盘
├── docs/
│   ├── four_round_scoring_spec.md  # 分层打分协议
│   └── prompt_template.sql         # Prompt 模板 (脱敏)
├── test_cases.json             # 测试用例
├── test_scoring.py             # 回归测试
├── compare_scoring.py          # 新旧版对比
├── concurrency_test.py         # 并发压测
├── start_all.sh / stop_all.sh  # 一键启停
├── .env.example                # 环境变量模板
├── requirements.txt
└── API.md
```

## 快速开始

### 1. 环境要求

| 项 | 版本 |
|---|---|
| OS | Ubuntu 22.04+ |
| GPU | NVIDIA A10 23GB+ |
| CUDA | 12.8+ |
| Python | 3.10+ |
| Node.js | 18+ |
| MySQL | 8.0+（或阿里云 RDS） |

### 2. 拉代码 + 配置

```bash
git clone git@github.com:bobosenses/resume-score.git
cd resume-score

# 环境变量（MySQL 等敏感配置）— 不进 git
cp .env.example .env.local
chmod 600 .env.local
vim .env.local              # 填入 MYSQL_HOST / USER / PASSWORD / DATABASE
```

`.env.local` 在 `.gitignore` 中，永远不会被提交。`start_all.sh` 启动前会 `source` 一次，server.js / rules_proxy.py 由此读取数据库凭据。

### 3. 下载模型

```bash
mkdir -p models

# LLM 推理
HF_ENDPOINT=https://hf-mirror.com huggingface-cli download \
    Qwen/Qwen3-8B-AWQ --local-dir models/Qwen3-8B-AWQ

# Embedding + Rerank
HF_ENDPOINT=https://hf-mirror.com huggingface-cli download \
    BAAI/bge-m3 --local-dir models/bge-m3 --exclude 'imgs/*'
HF_ENDPOINT=https://hf-mirror.com huggingface-cli download \
    BAAI/bge-reranker-v2-m3 --local-dir models/bge-reranker-v2-m3
```

| 模型 | 用途 | 大小 |
|---|---|---|
| Qwen3-8B-AWQ | LLM 推理 | ~6 GB |
| bge-m3 | 文本向量化 | 4.3 GB |
| bge-reranker-v2-m3 | 检索精排 | 2.2 GB |

### 4. 安装依赖

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

cd web && npm install && cd ..
```

### 5. 一键启动

```bash
./start_all.sh
```

启动顺序：vLLM (8003) → Web (3000) → Throttle (3100) → Monitor (3101) → Rules Proxy (8000) → ChromaDB (8001) → RAG (8002)。

初次启动 vLLM 加载模型约 90 秒，RAG API 加载 Embedding/Rerank 约 30 秒。

访问入口：

- Web 前端 — http://localhost:3000/
- 实时监控 — http://localhost:3000/monitor
- LLM API — http://localhost:8000/v1/
- Throttle 状态 — http://localhost:3100/stats
- Monitor 聚合 — http://localhost:3101/stats/all?window=10m

### 6. 停止

```bash
./stop_all.sh
```

## 接口说明

### 分层打分（推荐）

```bash
POST /api/score-layered
Content-Type: application/json

{
  "resume": "...",
  "jd": "...",
  "extra_rules": ""        # 可选, 追加到 scoring_rules.json
}
```

返回流式事件：

- `r1_done` — 简历结构化提取（含 experiences 数组）
- `r2_done` — 产品匹配判定
- `r3_done` — 职能匹配判定
- `r4_done` — 单项扣加分
- `final` — Layer0/1 闸门后的最终分数

走 Throttle Gateway 限流，过载时立刻 503，避免堆积。

### 普通对话 / 规则注入

```bash
POST http://localhost:8000/v1/chat/completions
{
  "model": "Qwen/Qwen3-8B-AWQ",
  "messages": [...],
  "use_scoring_rules": true   # 服务端注入 scoring_rules.json
}
```

### 规则热加载

```bash
# 改文件
vim config/scoring_rules.json

# API 更新
curl -X PUT http://localhost:8000/api/scoring-rules \
  -H "Content-Type: application/json" \
  -d '{"rules": "...", "version": "3.0.1"}'

# 页面
http://localhost:3000/ → 系统设置 → 编辑规则
```

### RAG 检索

```python
import requests
requests.post("http://localhost:8002/search", json={
    "query": "刻蚀工艺工程师",
    "rerank": True,
})
```

## 端口

| 端口 | 服务 | 暴露 |
|---|---|---|
| 3000 | Web 前端 | 公网 |
| 3100 | Throttle Gateway | 内网 |
| 3101 | Monitor API | 内网 |
| 8000 | Rules Proxy | 公网 |
| 8001 | ChromaDB | 公网 |
| 8002 | RAG API | 公网 |
| 8003 | vLLM | 内网 |

## 并发与容量（A10 23GB）

- 单请求 KV ≈ 0.7%，理论上限 ≈ 140 并发
- Throttle Gateway 自适应 capacity 上限约 30，R2/R3 并行后稳态 3000–3400 req/h
- 过载触发 503 fail-fast，前端按规则降级

详见 `docs/throttle-gateway.md` 与监控页面。

## 测试

```bash
source venv/bin/activate

# 单条回归
python3 test_scoring.py --api web

# 新旧版对比（3-round vs layered）
python3 compare_scoring.py

# 并发压测
python3 concurrency_test.py
```

## 日志

```bash
tail -f vllm.log throttle.log proxy.log web.log monitor_api.log
```

请求日志存于 `logs/request_logs.db`（SQLite），可通过 http://localhost:3000/logs 查看，支持时间/IP/状态码/关键字筛选。

## 安全注意

- 数据库密码、API Key、PII 数据 **绝不进 git**
- 真实简历目录 `case/`、`结果集*.csv`、`*打分情况.csv` 已在 `.gitignore`
- `.env.local` 权限设为 600（`chmod 600 .env.local`）
- `docs/#开头.md` 的个人备忘也被 ignore

## License

MIT
