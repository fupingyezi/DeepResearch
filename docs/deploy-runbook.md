# 部署操作手册（GitHub 端 + 腾讯云服务器端）

> 面向"从零到能访问"和"日常发版"两件事的具体操作清单。
> 设计文档见 [deployment.md](./deployment.md)，本文只讲**你要做什么**。

约定（下文直接沿用，换成你自己的值即可）：

- 部署目录：`/opt/mini-deepresearch`（与 GitHub Secret `DEPLOY_PATH` 一致）
- 服务器：腾讯云轻量/CVM，Ubuntu 系，公网 IP 记为 `<IP>`

---

## 一、GitHub 端（一次性，约 10 分钟）

### 1. 合并流水线分支

把 `chore/cicd-flow` 合并到 `main`（发 PR 或本地 merge 后 push）。合并后
`.github/workflows/deploy.yml` 生效，此后**每次 push main 都会自动部署**。

### 2. 配置 Secrets

仓库页面 → `Settings → Secrets and variables → Actions → New repository secret`，
共 4 个（`SSH_PORT` 可选第 5 个）：

| Secret        | 值                                         | 说明                          |
| ------------- | ------------------------------------------ | ----------------------------- |
| `SSH_HOST`    | `<IP>`                                     | 服务器公网 IP                 |
| `SSH_USER`    | `ubuntu`（或你的登录用户）                 | 须能免 sudo 用 docker（见下） |
| `SSH_KEY`     | 私钥**全文**（含首尾 `-----BEGIN/END...`） | 部署专用，不要复用个人密钥    |
| `SSH_PORT`    | `22`                                       | 改过 SSH 端口才需要配         |
| `DEPLOY_PATH` | `/opt/mini-deepresearch`                   | 与服务器目录一致              |

生成部署专用密钥（在你本地电脑执行）：

```bash
ssh-keygen -t ed25519 -C "deploy@mini-deepresearch" -f ~/.ssh/deploy_key
# 公钥追加到服务器（下一步服务器端会用到，也可现在就做）：
ssh-copy-id -i ~/.ssh/deploy_key.pub <SSH_USER>@<IP>
# 私钥全文复制进 SSH_KEY：
cat ~/.ssh/deploy_key
```

### 3. 确认 Actions 已启用

仓库 `Actions` 标签页，若提示 "Workflows aren't being run" 点 **Enable**。

GitHub 端到此完成，日常不用再动。

---

## 二、腾讯云服务器端（一次性，约 15 分钟）

### 1. 安装 Docker

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
# 国内服务器走 Aliyun 镜像源装 docker-ce，避免 download.docker.com 超时
sudo sh get-docker.sh --mirror Aliyun

# 让当前用户免 sudo 用 docker，然后退出重新登录生效
sudo usermod -aG docker "$USER"

# 配置 Docker Hub 镜像加速（腾讯云内网镜像）：
# compose 要拉 postgres/redis/minio 基础镜像，不配加速国内基本拉不动
sudo tee /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": ["https://mirror.ccs.tencentyun.com"]
}
EOF
sudo systemctl restart docker

# 验证：compose 为 v2 及以上，且能正常拉镜像
docker compose version
docker pull hello-world
```

### 2. 创建部署目录

```bash
sudo mkdir -p /opt/mini-deepresearch
sudo chown "$USER":"$USER" /opt/mini-deepresearch
```

### 3. 放置 .env.production

在本地仓库根目录把模板传上去再编辑：

```bash
scp .env.production.example <SSH_USER>@<IP>:/opt/mini-deepresearch/.env.production
ssh <SSH_USER>@<IP>
cd /opt/mini-deepresearch && vim .env.production
```

必改项（其余按需）：

| 变量                                                | 怎么填                                         |
| --------------------------------------------------- | ---------------------------------------------- |
| `AUTH_JWT_SECRET`                                   | `openssl rand -base64 48` 生成                 |
| `MODEL_KEY_ENC_SECRET`                              | `openssl rand -base64 32` 生成，**以后不可改** |
| `POSTGRES_PASSWORD` + `DATABASE_URL` 里的密码       | 同一个值，两处一致                             |
| `REDIS_PASSWORD` + `REDIS_URL` 里的密码             | 同一个值，两处一致                             |
| `MINIO_ROOT_PASSWORD` + `MINIO_SECRET_KEY`          | 同一个值，两处一致                             |
| `PUBLIC_URL`                                        | `http://<IP>:3000`（以后有域名再换）           |
| `OPENAI_QWEN_API_KEY` / `DEEPSEEK_API_KEY` 等模型键 | 按你实际用的模型填                             |
| `TAVILY_API_KEY`                                    | 搜索用，没有可留空                             |

> `DISABLE_SECURE_COOKIE=true` 先保留（HTTP 部署必须，否则登录不生效），
> 上 HTTPS 后删除该行。

可选——体验账号（登录页"一键体验"入口）：先在应用里注册好账号（如 `test@qq.com`），
再在 `.env.production` 加 `AUTH_DEMO_EMAIL` / `AUTH_DEMO_PASSWORD`（与账号同一对凭证）
并重建 app 容器（步骤见「六、注意事项」）；删除两行即关闭入口。
密码只存在服务器 env，不会进前端代码。

**随功能迭代新增的变量**（都是可选：不配也能跑，只是对应能力静默降级/走默认值。
`.env.production` 是早期一次性填的，新增能力不会自动补进去，按需核对）：

| 变量                                                         | 不配会怎样                                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `ZHIPU_API_KEY`                                              | 图片上传只落一段说明性占位文本（`view_image` 与视觉模型不可用）；记忆检索退回纯词面                                         |
| `ZHIPU_BASE_URL` / `ZHIPU_OCR_MODEL`                         | 可选，默认智谱官方端点 / `glm-ocr`                                                                                          |
| `DEERFLOW_EMBEDDING_API_KEY` / `_BASE_URL`                   | 可选，缺省回落 `ZHIPU_*`（embedding 与视觉用不同账号时才需填）                                                              |
| `DEERFLOW_EMBEDDING_MODEL` / `DEERFLOW_EMBEDDING_DIMENSIONS` | 可选，默认 `embedding-3` / 1024（改维度会让存量向量自动重嵌）                                                               |
| `DEERFLOW_VISION_MAX_IMAGE_MB`                               | 可选，默认 5（前端 `MAX_IMAGE_SIZE_MB` 必须 ≤ 它）                                                                          |
| `DEERFLOW_MAX_CONCURRENT_RUNS`                               | 可选，默认 16；**轻量服务器建议 4~6**，避免多对话并发把内存打满                                                             |
| `DEERFLOW_GUARDRAIL_ENABLED` / `DEERFLOW_GUARDRAIL_BLOCK`    | 可选，默认开启但只告警（`none`）                                                                                            |
| `DEERFLOW_SANDBOX_BACKEND`                                   | 可选，默认 `local`；`docker` 后端需 app 容器挂 docker socket（当前生产编排未挂，故不可用），`remote` 需 `DEERFLOW_REMOTE_*` |
| `AUTH_DEMO_EMAIL` / `AUTH_DEMO_PASSWORD`                     | 可选，一键体验入口；删掉两行即关闭                                                                                          |
| `MIN_FREE_GB`                                                | 可选，部署脚本的磁盘守卫阈值，默认 3G                                                                                       |

核对服务器上已配了哪些：

```bash
cd /opt/mini-deepresearch
for v in ZHIPU_API_KEY DEERFLOW_EMBEDDING_MODEL DEERFLOW_EMBEDDING_DIMENSIONS \
         DEERFLOW_VISION_MAX_IMAGE_MB DEERFLOW_MAX_CONCURRENT_RUNS DEERFLOW_SANDBOX_BACKEND; do
  grep -q "^${v}=" .env.production && echo "✓ ${v}" || echo "— 未配置 ${v}（走默认）"
done
```

### 4. 安全组 / 防火墙

腾讯云控制台 → 服务器 → 防火墙/安全组，只放行：

- `3000/tcp`（应用，来源 0.0.0.0/0 或收窄到你的 IP）
- SSH 端口（默认 22，建议来源收窄）

**不要放行** `5432 / 6379 / 9000 / 9001`——生产编排里 PG/Redis/MinIO 只绑定
`127.0.0.1`，公网本来就连不上，安全组也别开洞。

### 5. 自检

```bash
cd /opt/mini-deepresearch && ls        # 应有 .env.production
docker --version && docker compose version
```

服务器端到此完成。

---

## 三、首次部署与验收

直接在本地向 main 推送任意提交（或干脆就用合并流水线的那次 push），
然后看 GitHub `Actions`：

1. `quality` job 绿（lint / typecheck / build 都过）
2. `deploy` job 绿（构建镜像 → 传服务器 → 起服务 → 健康检查）

服务器上验收：

```bash
cd /opt/mini-deepresearch
docker compose --env-file .env.production -f docker-compose.prod.yaml ps   # 4 个服务，app 为 healthy
cat .previous-image    # 记录了上一版本 tag（首次部署没有，正常）
```

浏览器访问 `http://<IP>:3000`，注册账号、发一条对话验证流式回复。

---

## 四、日常发版

```bash
# 本地：提交（自动过 pre-commit + commitlint 校验）
git commit -m "feat: xxx"
git push origin main        # 推上去即自动发布
```

- 看 GitHub `Actions` 进度；`deploy` 结束即上线，全程约 3–6 分钟
- 健康检查失败会**自动回滚**到上一版本，Actions 日志里能看到回滚输出
- 同一批新 push 会取消进行中的旧部署（不排队）
- **纯文档改动不触发流水线**：改动全部落在 `**.md` / `docs/**` 时，Actions 里**不会出现新的 run**（服务器上不值得为改文档再跑一次全量构建）；`pull_request` 不受此过滤，PR 照常跑质量门禁

## 五、回滚与应急

```bash
# 手动回滚到上一版本（.previous-image 记录的那个）
cd /opt/mini-deepresearch && bash scripts/rollback.sh

# 回滚到任意历史版本（镜像在服务器本地按 git sha 打 tag，都留着）
docker images 'deepresearch:*'
APP_IMAGE=deepresearch:<sha> docker compose --env-file .env.production \
  -f docker-compose.prod.yaml up -d app
```

**服务器整体卡死（SSH 都慢/进不去）**：先怀疑磁盘写满或内存打满 —— 本机构建 + 同机跑
PG/Redis/MinIO/app，任何一项吃满都会让全机失去响应。

```bash
# ① 定性（重启后第一件事就是看这两个数）
df -h / ; free -m ; uptime
docker system df
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'   # 有无 Restarting

# ② 磁盘清理（构建缓存 → 悬空镜像 → 旧版本镜像，保留最近 3 版）
docker builder prune -f
docker image prune -f
docker images --filter reference='deepresearch' --format '{{.CreatedAt}}\t{{.Tag}}' \
  | sort -r | tail -n +4 | awk '{print $NF}' | xargs -r docker rmi

# ③ 清不出空间 / 内存打满时：控制台强制重启实例（容器 restart: unless-stopped 自动拉起）
```

- 部署脚本已内置守卫：构建前根分区 <3G 会先自动清构建缓存、仍不足则**快速失败**（不会硬着头皮构建）；部署成功后自动回收（构建缓存留 2G、镜像留最近 3 版）
- 控制台「监控」页的磁盘曲线长期 >85% → 优先扩容云硬盘，别等它写满
- 内存不够的典型症状：`journalctl -k | grep -i "killed process"` 能看到 OOM 记录

排查命令速查：

```bash
cd /opt/mini-deepresearch
docker compose --env-file .env.production -f docker-compose.prod.yaml logs --tail=100 app   # 应用日志
docker compose --env-file .env.production -f docker-compose.prod.yaml exec postgres \
  psql -U deepresearch -d DeepResearch -c "SELECT id,status FROM threads ORDER BY created_at DESC LIMIT 10;"
```

## 六、注意事项

- `.env.production` 只存在服务器上，CI 不会覆盖它；改完必须**重建 app 容器**才生效
  （`env_file` 只在容器创建时注入，`docker compose restart` 不会重读）：

  ```bash
  cd /opt/mini-deepresearch
  # 关键：把当前镜像 tag 传给 APP_IMAGE。不传会回落到 compose 里的 deepresearch:latest，
  # 而部署只打 deepresearch:<sha> 的 tag —— 要么拉取失败、要么误用旧镜像。
  APP_IMAGE="$(docker inspect --format '{{.Config.Image}}' \
    "$(docker compose --env-file .env.production -f docker-compose.prod.yaml ps -q app)")"
  APP_IMAGE="$APP_IMAGE" docker compose --env-file .env.production \
    -f docker-compose.prod.yaml up -d app
  ```

- `docker-compose.prod.yaml` 与 `scripts/*` 每次部署会被 CI 覆盖为仓库最新版，
  不要直接在服务器上改这两个（要改就改仓库）
- `DEPLOY_PATH` 下除 `.env.production` 与 `.previous-image` 外的文件都归 CI 解包管理：
  每次部署会把工作目录里不属于新源码包的遗留文件删掉再同步，不要在这里放其他东西
- 长期记忆 / 沙箱文件 / 自定义技能 / MCP 启用状态都在 named volume 里，
  重建容器不丢；但 `docker volume rm` 会丢

## 七、多进程运维

### 1. 确认协调态与排水态

```bash
# 每实例都查一遍：distributed=false 说明该实例已降级为进程内语义，多进程下要马上排查 Redis
curl -s http://127.0.0.1:3000/api/health
# 排水期返回 503；排水结束实例退出。滚动重启期间 LB 已摘除的实例出现 503 是正常的
```

### 2. 滚动重启（发版 / 扩缩容）

0. 前置：实例环境变量必须带 `NEXT_MANUAL_SIG_HANDLE=1`（compose 模板已配）——
   否则 SIGTERM 被 Next 自带的清理直接 exit(0)，排水序列不会执行（日志里
   看不到 `drain done`，在跑 run 会被硬杀、留给僵尸回收兜底）
1. 起新实例，等 `/api/health` 200 且 `distributed=true`，加入 LB
2. 对旧实例逐个执行：LB 摘除 → `docker stop`（发 SIGTERM，触发优雅排水，
   默认最多等 30s）→ 确认容器退出 → 下一个
3. 排水期间该实例的新请求返回 503/`SERVER_DRAINING`——摘除 LB 后新流量不该再进来，
   若还有请求进来，检查 LB 探活是否已指向 `/api/health`
4. 观察点：被排水的实例日志出现 `drain done cancelled=N pending=M`；
   N>0 表示有 run 被超时取消（用户会看到「已被取消」），M>0 表示取消后仍未收尾

### 3. 强杀后的僵尸清理（对账）

进程被 `kill -9` / OOM / 整机重启后，其 running 状态的 run 会在 owner 键到期
（约 45s）后被新启动的进程自动回收。不需要手动干预；**如需人工核对**：

```bash
# 终态应该是 failed + 文案 cancelled: process died
psql "$DATABASE_URL" -c \
  "SELECT run_id, thread_id, status, error FROM runs WHERE status='running' ORDER BY created_at DESC LIMIT 20;"
# 对应线程应已带出 running（idle 或 error）
psql "$DATABASE_URL" -c \
  "SELECT thread_id, status FROM threads WHERE status='running' LIMIT 20;"
```

残留 `running` 超过 2 分钟仍未回收，先查 Redis owner 键：

```bash
redis-cli -a "$REDIS_PASSWORD" --scan --pattern 'deerflow:run:owner:*' | head
# 有键 = owner 还活着（可能在别的实例上跑着，别动它）；无键且 PG 仍 running = 对账没跑，重启任一新实例
```

回收的同时会归还僵尸占用的全局并发名额（`deerflow:sandbox:runs:count` 与
per-run 槽键）。多次 `kill -9` 后若发现新 run 一直排队（queued），核对：

```bash
redis-cli -a "$REDIS_PASSWORD" GET deerflow:sandbox:runs:count
# 计数应 < DEERFLOW_MAX_CONCURRENT_RUNS；若接近上限而 PG 里没有对应数量的
# running run，说明对账轮次还没跑或回收失败，等下一轮（60s）或重启任一新实例
```

### 4. 扩缩容后的连接数核对

```bash
# 每实例 pg 池上限 × 实例数 + 余量，不能超过 PG max_connections（compose 已配 200）
redis-cli -a "$REDIS_PASSWORD" info clients | grep connected_clients   # Redis 侧同理粗看
psql "$DATABASE_URL" -c "SHOW max_connections;"
```
