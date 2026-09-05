#!/usr/bin/env bash
# HTTP 探活脚本：循环 curl 无副作用公开路由，就绪返回 0，超时返回非 0。
# 供 deploy-remote.sh 判断新版本是否健康。可通过环境变量调节：
#   APP_HEALTH_URL   探活地址（默认 http://127.0.0.1:3000/api/auth/setup-status）
#   HEALTH_RETRIES   最大重试次数（默认 30）
#   HEALTH_INTERVAL  每次间隔秒（默认 3）
# 判定：HTTP 状态码 < 500 视为存活（2xx/3xx/4xx 均说明进程已起并可响应）。

set -Eeuo pipefail

URL="${APP_HEALTH_URL:-http://127.0.0.1:3000/api/auth/setup-status}"
RETRIES="${HEALTH_RETRIES:-30}"
INTERVAL="${HEALTH_INTERVAL:-3}"

log() { echo "[health] $*"; }

log "探活: $URL（最多 ${RETRIES} 次，每次间隔 ${INTERVAL}s）"
for i in $(seq 1 "$RETRIES"); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL" || echo 000)"
  if [ "$CODE" != "000" ] && [ "$CODE" -lt 500 ]; then
    log "第 ${i} 次探活成功，HTTP $CODE"
    exit 0
  fi
  log "第 ${i}/${RETRIES} 次未就绪（HTTP $CODE），${INTERVAL}s 后重试"
  sleep "$INTERVAL"
done

log "探活失败：${RETRIES} 次内未就绪"
exit 1
