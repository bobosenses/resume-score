#!/bin/bash
# 一键停止所有服务
# 用法: ./stop_all.sh

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "============================================"
echo "  简历智能打分系统 - 停止所有服务"
echo "============================================"
echo ""

for PORT in 8003 8000 3101 3100 3000 8001 8002; do
    case $PORT in
        8003) NAME="vLLM" ;;
        8000) NAME="Rules Proxy" ;;
        3101) NAME="Monitor API" ;;
        3100) NAME="Throttle Gateway" ;;
        3000) NAME="Web 前端" ;;
        8001) NAME="ChromaDB" ;;
        8002) NAME="RAG API" ;;
    esac

    PIDS=$(lsof -ti:$PORT 2>/dev/null)
    if [ -n "$PIDS" ]; then
        echo -n "[停止] $NAME (端口 $PORT, PID=$PIDS) ... "
        kill $PIDS 2>/dev/null
        sleep 1
        # 强制杀死残留
        PIDS2=$(lsof -ti:$PORT 2>/dev/null)
        if [ -n "$PIDS2" ]; then
            kill -9 $PIDS2 2>/dev/null
        fi
        echo -e "${GREEN}OK${NC}"
    else
        echo -e "[跳过] $NAME (端口 $PORT) ${YELLOW}未运行${NC}"
    fi
done

echo ""
echo -e "${GREEN}所有服务已停止${NC}"
echo ""
