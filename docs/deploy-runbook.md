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
共 5 个：

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

## 五、回滚与应急

```bash
# 手动回滚到上一版本（.previous-image 记录的那个）
cd /opt/mini-deepresearch && bash scripts/rollback.sh

# 回滚到任意历史版本（镜像按 git sha 打 tag，都留着）
docker images 'deepresearch:*'
APP_IMAGE=deepresearch:<sha> docker compose --env-file .env.production \
  -f docker-compose.prod.yaml up -d app
```

排查命令速查：

```bash
cd /opt/mini-deepresearch
docker compose --env-file .env.production -f docker-compose.prod.yaml logs --tail=100 app   # 应用日志
docker compose --env-file .env.production -f docker-compose.prod.yaml exec postgres \
  psql -U deepresearch -d DeepResearch -c "SELECT id,status FROM threads ORDER BY created_at DESC LIMIT 10;"
```

## 六、注意事项

- `.env.production` 只存在服务器上，CI 不会覆盖它；改完重启生效：
  `docker compose --env-file .env.production -f docker-compose.prod.yaml up -d`
- `docker-compose.prod.yaml` 与 `scripts/*` 每次部署会被 CI 覆盖为仓库最新版，
  不要直接在服务器上改这两个（要改就改仓库）
- 长期记忆 / 沙箱文件 / 自定义技能 / MCP 启用状态都在 named volume 里，
  重建容器不丢；但 `docker volume rm` 会丢
