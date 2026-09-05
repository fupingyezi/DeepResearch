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

| 文件                           | 作用                                          |
| ------------------------------ | --------------------------------------------- |
| `.github/workflows/deploy.yml` | CI/CD 主流水线                                |
| `.husky/pre-commit`            | 提交前跑 lint-staged                          |
| `.husky/commit-msg`            | 校验提交信息规范                              |
| `commitlint.config.mjs`        | commit message 规则                           |
| `Dockerfile`                   | 多阶段 standalone 镜像构建                    |
| `.dockerignore`                | 排除密钥与运行期产物                          |
| `docker-compose.prod.yaml`     | 生产编排（app + PG/Redis/MinIO）              |
| `.env.production.example`      | 生产环境变量模板                              |
| `docs/deploy-runbook.md`       | 部署操作手册（GitHub 端 + 服务器端具体步骤）  |
| `docs/cicd-notes.md`           | 技术沉淀（设计缘由 + 踩坑实录 + 排查方法论）  |
| `scripts/deploy-remote.sh`     | 服务器端部署（load→起服务→健康检查→失败回滚） |
| `scripts/health-check.sh`      | HTTP 探活                                     |
| `scripts/rollback.sh`          | 回滚到上一版本镜像                            |
