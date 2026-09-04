#!/usr/bin/env bash
# 回滚脚本：把 app 切回 .previous-image 记录的上一版本镜像并重启。
# 由 deploy-remote.sh 在健康检查失败时自动调用，也可手动执行做紧急回滚。
# 工作目录须为 DEPLOY_PATH（含 docker-compose.prod.yaml 与 .previous-image）。

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="docker-compose.prod.yaml"
PREV_IMAGE_FILE=".previous-image"

log()  { echo "[rollback] $*"; }
fail() { echo "[rollback][ERROR] $*" >&2; exit 1; }

[ -f "$COMPOSE_FILE" ]    || fail "当前目录缺少 $COMPOSE_FILE（请在 DEPLOY_PATH 下执行）"
[ -f ".env.production" ]  || fail "当前目录缺少 .env.production（compose 凭证插值需要它）"
[ -s "$PREV_IMAGE_FILE" ] || fail "无 $PREV_IMAGE_FILE 记录，没有可回滚的上一版本"

PREV_IMAGE="$(cat "$PREV_IMAGE_FILE")"
log "回滚到上一版本镜像: $PREV_IMAGE"

# --env-file：与 deploy-remote.sh 一致，中间件凭证插值自 .env.production
compose() { docker compose --env-file .env.production -f "$COMPOSE_FILE" "$@"; }

# 回滚前 app 仍是失败版本，输出其最近日志便于排查
log "失败版本最近日志（tail 100）："
compose logs --tail=100 app || true

export APP_IMAGE="$PREV_IMAGE"
compose up -d app || fail "回滚启动失败，请人工介入"

log "开始回滚后健康检查..."
if bash "$SCRIPT_DIR/health-check.sh"; then
  log "回滚成功，服务恢复到: $PREV_IMAGE"
  exit 0
fi

fail "回滚后健康检查仍失败，请人工介入检查 $PREV_IMAGE"
