# 部署运维文档

本项目通过 GitHub Actions 实现端到端流水线：本地提交校验 → CI 质量门禁 → 构建 Docker 镜像 → SSH 部署到腾讯云服务器 → 健康检查失败自动回滚。

## 一、整体流程

```
本地 git commit
  ├─ husky pre-commit  → lint-staged（eslint --fix + prettier）
  └─ husky commit-msg  → commitlint（Conventional Commits）
        │
        ▼ git push main
GitHub Actions（.github/workflows/deploy.yml）
  ├─ job quality：pnpm install → lint → format:check → typecheck → test(占位) → build
  └─ job deploy（仅 push main）：git archive 打包源码(~0.5MB) → scp → SSH 解包并本地构建部署
        │
        ▼
腾讯云服务器
  docker build（本地，基础镜像走内网 mirror）→ 记录 previous → compose up → 健康检查
    ├─ 健康 → 发布成功
    └─ 不健康 → 自动回滚到 previous 镜像
```

本地钩子与 CI 复用同一批 npm scripts（`lint` / `format:check` / `typecheck` / `build`），保证校验标准一致。

## 二、GitHub Secrets 配置

在仓库 `Settings → Secrets and variables → Actions` 添加以下 Secrets（仅 SSH 连接凭证，**不含任何业务密钥**）：

| Secret        | 说明                               | 示例                      |
| ------------- | ---------------------------------- | ------------------------- |
| `SSH_HOST`    | 腾讯云服务器公网 IP 或域名         | `123.45.67.89`            |
| `SSH_USER`    | SSH 登录用户名                     | `ubuntu` / `root`         |
| `SSH_KEY`     | SSH 私钥全文（PEM 格式，含首尾行） | `-----BEGIN ... KEY-----` |
| `SSH_PORT`    | SSH 端口（可选，默认 22）          | `22`                      |
| `DEPLOY_PATH` | 服务器上的部署目录（绝对路径）     | `/opt/mini-deepresearch`  |

> 生成部署专用密钥：`ssh-keygen -t ed25519 -C "deploy@mini-deepresearch"`，公钥追加到服务器 `~/.ssh/authorized_keys`，私钥全文填入 `SSH_KEY`。

## 三、服务器初始化（首次）

1. **安装 Docker 与 Compose 插件**（以 Ubuntu 为例）：

   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker "$USER"   # 免 sudo 用 docker，重登生效
   docker compose version            # 确认 compose v2 可用
   ```

2. **创建部署目录**（须与 `DEPLOY_PATH` 一致）：

   ```bash
   sudo mkdir -p /opt/mini-deepresearch
   sudo chown "$USER":"$USER" /opt/mini-deepresearch
   ```

3. **放置生产环境变量文件 `.env.production`**：

   将仓库中的 `.env.production.example` 内容复制到服务器 `DEPLOY_PATH/.env.production`，填入真实密钥。

   ```bash
   cd /opt/mini-deepresearch
   vim .env.production
   ```

   关键项（务必修改默认值）：
   - `AUTH_JWT_SECRET`：`openssl rand -base64 48`
   - `MODEL_KEY_ENC_SECRET`：`openssl rand -base64 32`（设置后不可再改，否则已存模型密钥无法解密）
   - 中间件凭证三件套（compose 创建服务与应用连接用的是同一份值，须保持一致）：
     - `POSTGRES_PASSWORD` ↔ `DATABASE_URL` 中的密码
     - `REDIS_PASSWORD` ↔ `REDIS_URL` 中的密码（`redis://:密码@redis:6379`）
     - `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` ↔ `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`
   - `DATABASE_URL` / `REDIS_URL` / `MINIO_*`：host 指向 compose 服务名（`postgres` / `redis` / `minio`），端口不变
   - 各模型 `*_API_KEY`、`TAVILY_API_KEY`
   - HTTP 部署（未上 HTTPS）保留 `DISABLE_SECURE_COOKIE=true`，否则登录 cookie 带 Secure 标志无法回传，表现为登录不生效

   > `.env.production` 只存在于服务器本地，不进仓库、不进镜像层（已被 `.gitignore` 与 `.dockerignore` 排除）。

## 四、首次部署

配置好 Secrets 与服务器后，向 `main` 推送任意提交即触发全流程。首次部署时服务器无运行中的 app，脚本会跳过 previous 记录直接启动；首次构建需拉基础镜像 + 完整 `pnpm install`（可能 10 分钟+），之后 layer 缓存命中会明显变快。

也可在服务器手动执行（用于调试，前提：源码已解包到 DEPLOY_PATH）：

```bash
cd /opt/mini-deepresearch
chmod +x scripts/*.sh
bash scripts/deploy-remote.sh deepresearch:<git_sha>
```

部署成功后访问 `http://<SSH_HOST>:3000`。

## 五、健康检查

- **探针路由**：`/api/auth/setup-status`（公开 GET，无副作用，不触发鉴权 302）。
- **`/api/health`（多进程部署的 LB 探针）**：200 `{status:'ok'|'degraded', distributed, draining}`
  ——`distributed=false` 表示跨进程协调已降级，`draining=true` 期间返回 503 供 LB 摘除。
- **compose 层**：app 服务内置 `healthcheck`，用 node 探活（slim 镜像无 curl）。
- **部署层**：`scripts/health-check.sh` 循环 curl，HTTP 状态码 `< 500` 视为存活。可用环境变量调节：
  - `APP_HEALTH_URL`：探活地址（默认 `http://127.0.0.1:3000/api/auth/setup-status`）
  - `HEALTH_RETRIES`：最大重试次数（默认 30）
  - `HEALTH_INTERVAL`：每次间隔秒（默认 3）

## 六、回滚

**自动回滚**：部署脚本在健康检查失败时自动调用 `scripts/rollback.sh`，切回 `.previous-image` 记录的上一版本镜像并复检健康，同时打印失败版本的最近日志。

**手动回滚**：

```bash
cd /opt/mini-deepresearch
bash scripts/rollback.sh
```

> 回滚依赖 `DEPLOY_PATH/.previous-image` 文件（部署脚本每次切换前写入当前运行镜像 tag）。首次部署无此文件，故无可回滚版本。

## 七、版本机制

- 镜像 tag 使用 git 短 sha（前 12 位）：`deepresearch:<git_sha>`（服务器本地构建，不经 registry）。
- 每次部署前，脚本读取当前运行的 app 镜像并记入 `.previous-image`，作为回滚目标。
- 部署成功后执行 `docker image prune -f` 清理 dangling 镜像，但保留带 tag 的历史镜像与 previous 版本。

## 八、常见故障排查

| 现象                      | 可能原因与排查                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 页面样式/静态资源 404     | standalone 未拷贝 `.next/static` 或 `public`。检查 Dockerfile runner 阶段的 COPY 是否完整。                                                                                                                      |
| app 容器启动即退出        | `.env.production` 缺失或关键变量为空。`docker compose -f docker-compose.prod.yaml logs app` 看日志。                                                                                                             |
| app 连不上 PG/Redis/MinIO | env 中 host 写成了 `localhost`。容器内须用 compose 服务名 `postgres`/`redis`/`minio`。                                                                                                                           |
| 本机/外部直连中间件失败   | 生产编排中间件端口仅绑定 `127.0.0.1`，公网不可达。服务器上 `docker compose -f docker-compose.prod.yaml exec postgres psql -U deepresearch -d DeepResearch`，或从本地 `ssh -L 5432:127.0.0.1:5432 ...` 隧道访问。 |
| 健康检查一直失败          | 应用启动慢或端口不对。加大 `HEALTH_RETRIES`；确认容器 `PORT=3000` 且 compose 端口映射正确。                                                                                                                      |
| CI 部署卡在 scp/ssh       | Secrets 配置错误（HOST/USER/KEY/PORT），或服务器防火墙未放行 SSH 端口。                                                                                                                                          |
| CI push/pull TCR 失败     | ~~已废弃 TCR 方案~~（跨境 manifest 稳定挂起）。现为服务器本地构建；构建慢/失败查 `df -h` 磁盘与 `free -m` 内存（next build 需 ~2GB）。                                                                           |
| CI quality job 失败       | 本地先跑 `pnpm lint && pnpm format:check && pnpm typecheck && pnpm build` 复现并修复。                                                                                                                           |
| commit 被拒（commit-msg） | 提交信息不符合 Conventional Commits。格式：`type(scope): 描述`，type 见 commitlint.config.mjs。                                                                                                                  |

## 九、涉及文件清单

| 文件                           | 作用                                           |
| ------------------------------ | ---------------------------------------------- |
| `.github/workflows/deploy.yml` | CI/CD 主流水线                                 |
| `.husky/pre-commit`            | 提交前跑 lint-staged                           |
| `.husky/commit-msg`            | 校验提交信息规范                               |
| `commitlint.config.mjs`        | commit message 规则                            |
| `Dockerfile`                   | 多阶段 standalone 镜像构建                     |
| `.dockerignore`                | 排除密钥与运行期产物                           |
| `docker-compose.prod.yaml`     | 生产编排（app + PG/Redis/MinIO）               |
| `.env.production.example`      | 生产环境变量模板                               |
| `docs/deploy-runbook.md`       | 部署操作手册（GitHub 端 + 服务器端具体步骤）   |
| `docs/cicd-notes.md`           | 技术沉淀（设计缘由 + 踩坑实录 + 排查方法论）   |
| `scripts/deploy-remote.sh`     | 服务器端部署（build→起服务→健康检查→失败回滚） |
| `scripts/health-check.sh`      | HTTP 探活                                      |
| `scripts/rollback.sh`          | 回滚到上一版本镜像                             |

## 十、多进程部署

单进程撑不住时（`DEERFLOW_MAX_CONCURRENT_RUNS` 已调满、LLM 调用量触顶），横向扩到多实例。
控制面（取消/抢占/删除）与事件面（SSE 回放/重连）均已跨进程化，扩实例不改业务代码，
只动编排与监控。

### 10.1 前提与降级可见性

- **唯一额外依赖是 `REDIS_URL`**：run owner 登记、取消广播、SSE 事件镜像、沙箱协调全走它。
  未配置（或运行期连不上）时自动降级为进程内语义——取消/流回放都只能命中发起进程，
  多进程部署下这等于功能错乱。`GET /api/health` 返回 `distributed` 字段，**多进程部署必须
  在监控上盯住 `distributed=false`**（响应为 200 `degraded`，仍是活的，但语义退化）。
- **PG max_connections 重算**：连接数 = 每进程 pg 池上限 × 进程数 + 管理余量。
  官方镜像缺省 100，3 个进程即可触顶（表现是「重启后偶发连不上库」的 5xx）。
  生产 compose 已配 `max_connections=200`，进程数再增时按需上调。

### 10.2 负载均衡：不需要粘性

- SSE 事件经 Redis Stream 镜像（`deerflow:stream:{threadId}:{runId}`，24h TTL）；
  断线重连靠 `fromEventId` 续读，任意实例都能接住任意线程的流。
- 会话标识在请求 JSON body 里（`sessionId`），nginx 的 `hash $arg_sessionId` 一类
  query-arg 粘性片段不适用——照抄会恒等哈希到同一实例，看起来像粘性其实是巧合。
- LB 探活指向 `/api/health`：200 = 健康（`ok` 跨进程 / `degraded` 降级），
  **503 = 排水期，LB 应摘除该实例**。

### 10.3 优雅停机

前置：实例必须带 `NEXT_MANUAL_SIG_HANDLE=1` 运行（compose 模板已配）——Next
自带的 SIGTERM 清理是 `server.close → exit(0)`，不关掉它，排水序列跑不到第一步。

SIGTERM 触发的停机序列（`src/instrumentation.ts`）：

1. 置 draining：`/api/health` 转 503，submitRun/resume 抛 `SERVER_DRAINING`
2. 等待运行中 run 自然收尾，窗口 `DEERFLOW_GRACEFUL_DRAIN_MS`（默认 30s）
3. 超时取消剩余 run（文案 `cancelled: server draining`，END 帧照常落流），再等 3s 收尾
4. flush 记忆更新队列（10s 超时上限）
5. 退出（第二个 SIGTERM/SIGINT 立即 `process.exit(1)`）

编排侧：compose `stop_grace_period` 必须大于排水窗口（模板配 60s > 30s），否则
compose 在排水完成前 SIGKILL，被强杀的 run 留给僵尸回收兜底。滚动发布时逐实例
重启，配合 LB 摘除 503 实例，滚动期间无 5xx。

### 10.4 僵尸 run 回收

owner 进程被 kill -9（或整机断电）时，PG 里 `runs.status='running'` 的记录会成为
僵尸——用户刷新看到永远转圈。判死与回收机制：

- 执行体心跳（15s）持续续租 Redis owner 键（TTL 45s = 3 个心跳窗口，见
  `runtime/liveness.ts`）；键到期 = owner 已死（`ownerOf` 返回 null）
- 新进程启动时对账（`runtime/zombie-reconciler.ts`，启动 + 60s 两轮：覆盖
  owner 键尚未到期的窗口）：running 且 owner 为空的 run → `failed` +
  `cancelled: process died`，线程状态带出 running
- 回收同时归还该 run 的全局并发名额（per-run 槽键释放）：kill -9 的 run 走不到
  finally，名额不还则全局并发上限随僵尸流失，多次强杀后新 run 永久排队
- 误判防护：低于一个心跳窗口的 run 视为刚启动跳过；线程状态只随**最新** run 走
  （抢占时旧 owner 崩溃不覆盖新 run 的 running）

### 10.5 进程管理选型

- **多容器 / k8s replicas（优先）**：每容器单进程，SIGTERM 语义最干净，drain、
  健康检查、滚动发布都是平台原语。
- **PM2 cluster**：可行，但 drain 依赖信号送达每个 worker。注意 run 级并发闸门
  的计数方式：进程内信号量上限是 `DEERFLOW_MAX_CONCURRENT_RUNS`，而跨进程占位
  （Redis `runs:count`）以**相同值作为全局上限**——总并发不是「上限 × 实例数」，
  扩容时全局上限不变，需按新容量调大 `DEERFLOW_MAX_CONCURRENT_RUNS`。
