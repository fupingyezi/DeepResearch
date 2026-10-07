#!/usr/bin/env bash
# 幂等启动 HTTP MCP 服务（默认 127.0.0.1:3333），nohup 脱离本进程后台运行。
# 已在健康状态则直接返回；否则启动后等待健康检查（最多 30s）。
# MCP 工具在每轮对话开始加载，本轮对话启动只惠及后续对话（见 references/mcp-integration.md）。
set -euo pipefail

# 示例模板不内置默认路径：使用前必须设置 OBSIDIAN_RAG_DIR（或修改本行换成本机路径）
RAG_DIR="${OBSIDIAN_RAG_DIR:?请设置 OBSIDIAN_RAG_DIR 指向 obsidian-rag 项目目录，或修改本行换成本机路径}"
MCP_URL="${OBSIDIAN_RAG_MCP_URL:-http://127.0.0.1:3333/mcp}"
PID_FILE="/tmp/obsidian-rag-mcp.pid"
LOG_FILE="/tmp/obsidian-rag-mcp.log"

# 健康判定：任何 HTTP 响应（含 405）都算「端口上有服务」，000 才算没起。
health() {
  local code
  code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$MCP_URL" 2>/dev/null || true)
  [ -n "$code" ] && [ "$code" != "000" ]
}

if health; then
  echo "obsidian-rag MCP 已在运行 ($MCP_URL)"
  exit 0
fi

if [ ! -d "$RAG_DIR" ]; then
  echo "obsidian-rag 项目目录不存在: $RAG_DIR（请设置 OBSIDIAN_RAG_DIR）" >&2
  exit 1
fi

cd "$RAG_DIR"
nohup npm run mcp:http >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

for _ in $(seq 1 30); do
  if health; then
    echo "obsidian-rag MCP 已启动 (pid $(cat "$PID_FILE"), $MCP_URL)"
    exit 0
  fi
  sleep 1
done

echo "服务已拉起但 30s 内未通过健康检查，日志见 $LOG_FILE" >&2
exit 1
