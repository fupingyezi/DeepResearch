#!/usr/bin/env bash
# 服务器端部署脚本（由 CI 经 SSH 调用，也可手动执行）。
# 职责：本地 docker build 新镜像 → 记录当前版本为 previous → 用新镜像起 app →
#       健康检查失败则自动回滚到 previous 并保留失败日志。
# 每一步显式判退出码并输出上下文，杜绝“半启动”状态。
#
# 约定的参数：
#   $1  新镜像完整 tag（如 deepresearch:<git_sha>）
# 构建上下文为当前目录（CI 已解包源码）；基础镜像经腾讯内网 mirror 拉取。
# 工作目录须为 DEPLOY_PATH（含 Dockerfile、docker-compose.prod.yaml 与 .env.production）。

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="docker-compose.prod.yaml"
PREV_IMAGE_FILE=".previous-image"

NEW_IMAGE="${1:?用法: deploy-remote.sh <image:tag>}"

log()  { echo "[deploy] $*"; }
fail() { echo "[deploy][ERROR] $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "未找到 docker，请先在服务器安装 docker"
[ -f "Dockerfile" ]      || fail "当前目录缺少 Dockerfile（源码包未解包？）"
[ -f "$COMPOSE_FILE" ]   || fail "当前目录缺少 $COMPOSE_FILE（请在 DEPLOY_PATH 下执行）"
[ -f ".env.production" ] || fail "当前目录缺少 .env.production（业务密钥文件）"

# --env-file：compose 文件中的 ${POSTGRES_PASSWORD} 等中间件凭证插值自 .env.production
compose() { docker compose --env-file .env.production -f "$COMPOSE_FILE" "$@"; }

# 记录当前正在运行的 app 镜像，作为回滚目标
CURRENT_IMAGE="$(compose ps -q app 2>/dev/null | xargs -r docker inspect --format '{{.Config.Image}}' 2>/dev/null || true)"
if [ -n "$CURRENT_IMAGE" ]; then
  log "记录当前版本为 previous: $CURRENT_IMAGE"
  echo "$CURRENT_IMAGE" > "$PREV_IMAGE_FILE"
else
  log "未检测到运行中的 app（首次部署），无 previous 版本"
fi

log "构建新镜像: $NEW_IMAGE（首次较慢，后续有 layer 缓存）"
docker build -t "$NEW_IMAGE" . || fail "docker build 失败（见上方构建日志）"

log "以新镜像启动 app: $NEW_IMAGE"
export APP_IMAGE="$NEW_IMAGE"
compose up -d app postgres redis minio || fail "docker compose up 失败"

log "开始健康检查..."
if APP_HEALTH_URL="${APP_HEALTH_URL:-http://127.0.0.1:3000/api/auth/setup-status}" \
   bash "$SCRIPT_DIR/health-check.sh"; then
  log "部署成功，新版本健康: $NEW_IMAGE"
  docker image prune -f >/dev/null 2>&1 || true
  exit 0
fi

log "健康检查失败，开始回滚..."
compose logs --tail=100 app || true
if [ -s "$PREV_IMAGE_FILE" ]; then
  bash "$SCRIPT_DIR/rollback.sh" || fail "回滚执行失败，请人工介入"
  fail "新版本 $NEW_IMAGE 不健康，已回滚到上一版本"
else
  fail "新版本 $NEW_IMAGE 不健康且无 previous 版本可回滚，请人工介入"
fi
