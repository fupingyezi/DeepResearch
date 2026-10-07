#!/usr/bin/env bash
# 停止 HTTP MCP 服务：按 pidfile 杀 npm 进程，pkill 兜底 tsx/node 子进程，
# 最后按端口清场并确认释放。杀掉已停止的服务也无害（幂等）。
set -euo pipefail

PID_FILE="/tmp/obsidian-rag-mcp.pid"
PORT="${OBSIDIAN_RAG_MCP_PORT:-3333}"

# npm 进程本身（它的 tsx 子进程由下一行兜底）
if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  rm -f "$PID_FILE"
fi

# tsx 启动的 mcp 子进程（nohup 下不一定随 npm 退出）
pkill -f "src/shell/mcp.ts" 2>/dev/null || true

# 端口兜底：占着 3333 的进程一律终止
for pid in $(lsof -ti :"$PORT" 2>/dev/null); do
  kill "$pid" 2>/dev/null || true
done

sleep 1

if lsof -ti :"$PORT" >/dev/null 2>&1; then
  echo "端口 $PORT 仍被占用，服务未能完全停止" >&2
  exit 1
fi
echo "obsidian-rag MCP 已停止"
