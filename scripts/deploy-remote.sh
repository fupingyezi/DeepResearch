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

# 磁盘守卫：本机构建把构建缓存、按 sha 保留的历史镜像、容器日志都压在同一块盘上，
# 写满会让整台机器（含 SSH）失去响应。低于阈值先自动清构建缓存，仍不够就快速失败 ——
# 宁可这次部署失败，也不要压垮服务器。
MIN_FREE_GB="${MIN_FREE_GB:-3}"
ensure_disk_space() {
  local free_gb
  free_gb="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
  if [ "${free_gb:-0}" -ge "$MIN_FREE_GB" ]; then
    log "磁盘可用 ${free_gb}G（阈值 ${MIN_FREE_GB}G）"
    return 0
  fi
  log "磁盘可用仅 ${free_gb}G，低于阈值 ${MIN_FREE_GB}G，先自动清理构建缓存"
  docker builder prune -f >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
  free_gb="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
  if [ "${free_gb:-0}" -lt "$MIN_FREE_GB" ]; then
    fail "清理后磁盘仍只有 ${free_gb}G（需 ≥ ${MIN_FREE_GB}G）。请清理历史镜像（docker images --filter reference=deepresearch）与容器日志，或在控制台扩容云硬盘。"
  fi
  log "清理后磁盘可用 ${free_gb}G，继续部署"
}

# 内存守卫（与磁盘守卫同哲学）：本机构建与 PG/Redis/MinIO/app 同机争内存。构建容器
# 内存上限 = 当前可用内存 − 同机服务预留；--memory-swap = 上限 + 溢出额度（有界换入
# 宿主 swap）：超总限以明确 OOM 快速失败，而不是无界 swap 风暴把整机（含正在跑的
# 旧版本 app）拖死——那种死法旧 app 跟着不可访问，只能重启整机恢复（见 §15）。
# 注意 NODE_OPTIONS 的堆上限只罩得住构建主进程（Next fork 静态 worker 时主动剥掉），
# 容器级上限才对「主进程 + worker fork 群」整体生效。
# 预留值按构建峰值实测标定（本机隔离复刻：NEXT_BUILD_CPUS=1 + NODE_OPTIONS=2048）
# 冷构建峰值 1958MB / 暖构建 1699MB——但那是快 CPU 的乐观值：服务器慢 CPU 编译期长，
# 主进程堆顶满 NODE_OPTIONS 上限，实测额度 2.3G 仍在编译期被 cgroup OOM（两轮
# 42.7s / 67.3s，§15 校准；Dockerfile 已把堆上限压到 1536 抵消这一项）。4G 无 swap
# 机器预算 = 3719 − 同机服务 ~1.1G − 系统/页缓存，额度 ≈ 可用 − 128 是极限
# （扩容后应调回 512）；峰值超出额度的余量靠 BUILD_SWAP_MB 溢出到宿主 swap。
MEM_RESERVE_MB="${BUILD_MEM_RESERVE_MB:-128}" # 给同机 PG/Redis/MinIO/app + 系统预留
MIN_BUILD_MB="${BUILD_MEM_MIN_MB:-1024}"      # 构建自身下限，低于此值宁可快速失败
BUILD_SWAP_MB="${BUILD_SWAP_MB:-2048}"        # 内存溢出额度：换入宿主 swap 的上限
ensure_memory_headroom() {
  local avail_mb
  avail_mb="$(free -m | awk '/^Mem:/ {print $7}')"
  case "$avail_mb" in
    ''|*[!0-9]*) log "可用内存解析失败（${avail_mb}），跳过内存守卫"; return 0 ;;
  esac
  BUILD_MEM_MB=$((avail_mb - MEM_RESERVE_MB))
  if [ "$BUILD_MEM_MB" -lt "$MIN_BUILD_MB" ]; then
    fail "可用内存仅 ${avail_mb}MB，低于 构建下限 ${MIN_BUILD_MB}MB + 预留 ${MEM_RESERVE_MB}MB。请停掉非必要进程或扩容内存后再部署。"
  fi
  BUILD_MEM_SWAP_MB=$((BUILD_MEM_MB + BUILD_SWAP_MB))
  log "内存守卫：可用 ${avail_mb}MB，构建容器上限 ${BUILD_MEM_MB}MB + swap 额度 ${BUILD_SWAP_MB}MB（预留 ${MEM_RESERVE_MB}MB）"
}

# 部署成功后的回收：镜像只留最近 3 个版本（回滚只需要上一版，留 3 个够用），构建缓存
# 保留 2G 以维持构建速度。不回收的话磁盘只增不减（每次部署多一份全量镜像）。
#
# 注意 --format 必须直接产出 repository:tag 完整引用：曾用 '{{.Tag}}' 只取裸 tag，
# docker rmi 会把 12 位 hex 的 tag 当成「镜像 ID 前缀:latest」解析 → No such image，
# 回收从未生效（服务器上积了 12 个历史镜像）——错误被 '|| true' 吞掉，只在真机上复现
# 才现形。grep -v '<none>' 兜底悬空 tag。
cleanup_after_deploy() {
  docker builder prune -f --keep-storage 2GB >/dev/null 2>&1 || true
  docker images --filter reference='deepresearch' --format '{{.Repository}}:{{.Tag}}' \
    | grep -v ':<none>' | sort -r | tail -n +4 \
    | xargs -r docker rmi >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
  log "已回收：构建缓存保留 2G，镜像保留最近 3 个版本"
}

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

ensure_disk_space
ensure_memory_headroom

log "构建新镜像: $NEW_IMAGE（首次较慢，后续有 layer 缓存）"
# 墙钟超时兜底：构建只剩 webpack 编译（lint/typecheck 在 quality 门禁跑，见 next.config），
# 正常数分钟内完成。若因同机负载等病态挂起，到点主动终止 docker CLI 并以明确错误失败，
# 而不是被上层 ssh-action 超时连脚本一起掐掉——那种死法构建会残留在 dockerd 继续吃资源，
# 且下一次部署的构建层永远无缓存（被掐掉的层不进缓存）。
BUILD_FLAGS=(-t "$NEW_IMAGE")
if [ -n "${BUILD_MEM_MB:-}" ]; then
  # 内存守卫下发的容器级上限；--memory-swap 多出 BUILD_SWAP_MB 的溢出额度（有界换入
  # 宿主 swap：总量封顶，swap 风暴不可能发生）。宿主未配 swap 时该额度天然失效
  BUILD_FLAGS+=(--memory "${BUILD_MEM_MB}m" --memory-swap "${BUILD_MEM_SWAP_MB}m")
fi
timeout "${BUILD_TIMEOUT:-30m}" docker build "${BUILD_FLAGS[@]}" . || {
  log "构建失败后的观测（旧版本容器应仍在运行）："
  free -m
  compose ps || true
  fail "docker build 失败或超时 ${BUILD_TIMEOUT:-30m}（见上方构建日志）。旧版本容器未受影响仍在运行；若因内存不足 OOM，调参指引见 docs/cicd-notes.md §15。"
}

log "以新镜像启动 app: $NEW_IMAGE"
export APP_IMAGE="$NEW_IMAGE"
compose up -d app postgres redis minio || fail "docker compose up 失败"

log "开始健康检查..."
if APP_HEALTH_URL="${APP_HEALTH_URL:-http://127.0.0.1:3000/api/auth/setup-status}" \
   bash "$SCRIPT_DIR/health-check.sh"; then
  log "部署成功，新版本健康: $NEW_IMAGE"
  cleanup_after_deploy
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
