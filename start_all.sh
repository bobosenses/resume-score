#!/bin/bash
# 一键启动所有服务
# 用法: ./start_all.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo "============================================"
echo "  简历智能打分系统 - 启动所有服务"
echo "============================================"
echo ""

# 激活虚拟环境
source "$SCRIPT_DIR/venv/bin/activate"

# ========== 1. vLLM (端口 8003) ==========
if ss -tlnp | grep -q ":8003 "; then
    echo -e "${YELLOW}[跳过]${NC} vLLM 已在运行 (端口 8003)"
else
    echo -n "[启动] vLLM (端口 8003) ... "
    nohup vllm serve "$SCRIPT_DIR/models/Qwen3-8B-FP8" \
        --host 0.0.0.0 --port 8003 \
        --max-model-len 32768 \
        --gpu-memory-utilization 0.9 \
        > "$SCRIPT_DIR/vllm.log" 2>&1 &
    VLLM_PID=$!

    # 等待 vLLM 就绪（最多 120 秒）
    for i in $(seq 1 60); do
        if curl -s --max-time 2 http://127.0.0.1:8003/v1/models > /dev/null 2>&1; then
            echo -e "${GREEN}OK${NC} (PID=$VLLM_PID, 等待 ${i}x2s)"
            break
        fi
        if [ $i -eq 60 ]; then
            echo -e "${RED}超时${NC} (请检查 vllm.log)"
            exit 1
        fi
        sleep 2
    done
fi

# ========== 2. Rules Proxy (端口 8000) ==========
if ss -tlnp | grep -q ":8000 "; then
    echo -e "${YELLOW}[跳过]${NC} Rules Proxy 已在运行 (端口 8000)"
else
    echo -n "[启动] Rules Proxy (端口 8000) ... "
    nohup python3 "$SCRIPT_DIR/rules_proxy.py" > "$SCRIPT_DIR/proxy.log" 2>&1 &
    PROXY_PID=$!
    sleep 3
    if ss -tlnp | grep -q ":8000 "; then
        echo -e "${GREEN}OK${NC} (PID=$PROXY_PID)"
    else
        echo -e "${RED}失败${NC} (请检查 proxy.log)"
        exit 1
    fi
fi

# ========== 3. Web 前端 (端口 3000) ==========
if ss -tlnp | grep -q ":3000 "; then
    echo -e "${YELLOW}[跳过]${NC} Web 前端已在运行 (端口 3000)"
else
    echo -n "[启动] Web 前端 (端口 3000) ... "
    cd "$SCRIPT_DIR/web"
    nohup node server.js > "$SCRIPT_DIR/web.log" 2>&1 &
    WEB_PID=$!
    cd "$SCRIPT_DIR"
    sleep 2
    if ss -tlnp | grep -q ":3000 "; then
        echo -e "${GREEN}OK${NC} (PID=$WEB_PID)"
    else
        echo -e "${RED}失败${NC} (请检查 web.log)"
        exit 1
    fi
fi

# ========== 4. ChromaDB (端口 8001) ==========
if ss -tlnp | grep -q ":8001 "; then
    echo -e "${YELLOW}[跳过]${NC} ChromaDB 已在运行 (端口 8001)"
else
    echo -n "[启动] ChromaDB (端口 8001) ... "
    nohup chroma run --host 0.0.0.0 --port 8001 --path "$SCRIPT_DIR/chromadb-data" > "$SCRIPT_DIR/chromadb.log" 2>&1 &
    CHROMA_PID=$!
    sleep 3
    if ss -tlnp | grep -q ":8001 "; then
        echo -e "${GREEN}OK${NC} (PID=$CHROMA_PID)"
    else
        echo -e "${RED}失败${NC} (请检查 chromadb.log)"
        exit 1
    fi
fi

# ========== 5. RAG API (端口 8002) ==========
if ss -tlnp | grep -q ":8002 "; then
    echo -e "${YELLOW}[跳过]${NC} RAG API 已在运行 (端口 8002)"
else
    echo -n "[启动] RAG API (端口 8002) ... "
    nohup python3 "$SCRIPT_DIR/chromadb_api.py" > "$SCRIPT_DIR/rag_api.log" 2>&1 &
    RAG_PID=$!
    sleep 30  # RAG API 需要加载 Embedding 和 Rerank 模型（CPU，较慢）
    if ss -tlnp | grep -q ":8002 "; then
        echo -e "${GREEN}OK${NC} (PID=$RAG_PID)"
    else
        echo -e "${RED}失败${NC} (请检查 rag_api.log)"
        exit 1
    fi
fi

echo ""
echo "============================================"
echo -e "  ${GREEN}所有服务启动完成${NC}"
echo "============================================"
echo ""
echo "  Web 前端:      http://localhost:3000/"
echo "  LLM API:       http://localhost:8000/v1/"
echo "  RAG API:       http://localhost:8002/"
echo "  ChromaDB:      http://localhost:8001/"
echo ""
echo "  日志: tail -f vllm.log"
echo "  停止: ./stop_all.sh"
echo ""
