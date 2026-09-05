# CI/CD 与部署技术沉淀（从零到首次上线实录）

> 定位：本文是「为什么这样设计 + 踩过哪些坑 + 怎么定位的」的知识沉淀。
> 三份文档配合使用：
>
> | 文档                                     | 回答的问题               |
> | ---------------------------------------- | ------------------------ |
> | [deployment.md](./deployment.md)         | 系统怎么设计的           |
> | [deploy-runbook.md](./deploy-runbook.md) | 我具体要做哪些操作       |
> | **本文（cicd-notes.md）**                | 为什么 + 坑在哪 + 怎么排 |
>
> 记录时间：2026-09，分支 `chore/cicd-flow`，目标腾讯云 Ubuntu 服务器。

---

## 1. 全景架构

```
开发者本地（Mac）
  git commit ──► husky 钩子校验（lint-staged + commitlint）
  git push main
        │
        ▼
GitHub Actions（.github/workflows/deploy.yml）
  ├─ job quality：install --frozen-lockfile → lint → format:check
  │                → typecheck → test(占位) → build
  └─ job deploy（仅 push main，quality 通过后）
       git archive 打包源码（~0.5MB，git 跟踪文件）
       → scp 上传源码包
       → SSH：解包 → 服务器本地 docker build（基础镜像走腾讯内网 mirror）
            → deploy-remote.sh（tag = deepresearch:<git sha 前 12 位>）
        │
        ▼
腾讯云服务器 /opt/mini-deepresearch
  docker build → 记录 .previous-image → compose up（PG/Redis 健康后才起 app）
  → 健康检查（30 次 × 3s，HTTP < 500 视为存活）
     ├─ 健康 → 发布成功，prune 清理
     └─ 失败 → 自动回滚 .previous-image → 复检 → 仍败则请求人工
```

**密钥分层**（本设计的核心原则）：

| 层             | 存什么                                            | 在哪                              |
| -------------- | ------------------------------------------------- | --------------------------------- |
| GitHub Secrets | 仅 4~5 个 SSH 连接凭证（HOST/USER/KEY/PORT/PATH） | GitHub，CI 可读                   |
| 业务密钥       | 模型 API key、DB 密码、JWT secret 等              | 只在服务器 `.env.production`      |
| 镜像           | 无任何密钥（运行期 env_file 注入）                | 服务器本地构建，不经任何 registry |

---

## 2. 本地提交校验链

### 组成

| 组件          | 钩子         | 作用                                                   |
| ------------- | ------------ | ------------------------------------------------------ |
| `lint-staged` | `pre-commit` | 对 staged 文件 `eslint --fix` + `prettier --write`     |
| `commitlint`  | `commit-msg` | Conventional Commits 校验（type-enum 11 种，中文适配） |

commitlint 对中文的关键放宽：`subject-case` 关闭、subject 上限 100、header 上限 120——否则中文 subject 天然触发大小写/长度误杀。

### 激活机制（重要认知）

husky v9 的钩子**不是文件放那就生效**的：

1. `package.json` 的 `"prepare": "husky"` 在 **`pnpm install` 时**执行
2. 它做两件事：`git config core.hooksPath .husky/_` + 在 `.husky/_/` 生成所有钩子的 shim
3. git commit 时经 hooksPath 找到 shim，shim 再 source `.husky/<钩子名>`

**验证是否激活**：`git config core.hooksPath` 有值 + `ls .husky/_` 存在。

> 踩坑 #1：新 clone 只 checkout 了 `.husky/pre-commit` 文件但没跑过 install →
> 钩子是"死"的，commit 什么都不检查。跑一次 `pnpm install` 即激活。

---

## 3. CI 质量门禁：一次修通了四层问题

lint 从项目诞生起就没真正跑起来过（之前提交的都是 md/yaml，eslint 未被触发）。
首次在 CI 真跑，剥洋葱式暴露四层问题：

### 3.1 ESM 导入缺扩展名

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...eslint-config-next/core-web-vitals'
Did you mean to import "eslint-config-next/core-web-vitals.js"?
```

ESLint 9 的 flat config 是 ESM，Node 的 ESM 解析**要求显式扩展名**。改 import 加 `.js`。

### 3.2 eslintrc 配置 ≠ flat config

修完 3.1 后报 `nextVitals is not iterable`——因为 `eslint-config-next`（无论 v14
还是 v15）导出的是**老式 eslintrc 对象** `{ extends: [...] }`，不是 flat 数组，
不能直接 spread。标准解法是 `create-next-app` 同款的 `FlatCompat` 转换：

```js
import { FlatCompat } from '@eslint/eslintrc';
const compat = new FlatCompat({ baseDirectory: import.meta.dirname });
// compat.extends('next/core-web-vitals', 'next/typescript') 生成 flat 数组
```

`@eslint/eslintrc` 需要显式安装为 devDependency（pnpm 严格 node_modules 下
裸引传递依赖会失败）。

### 3.3 插件版本与 ESLint 9 不兼容

修完 3.2 后报 `context.getAncestors is not a function`——`@next/eslint-plugin-next`
v14 的规则用了 **ESLint 9 已删除的 API**，直接崩溃。把 `eslint-config-next`
从 14.2.33 升到 15.5.25（插件 v15 为 ESLint 9 重写；对 Next 14 代码兼容）。

### 3.4 存量代码 204 个问题怎么处理

lint 终于能跑后暴露 183 errors（178 个 `no-explicit-any`、18 个未用变量等）。
**决策：风格类降为 warn 不阻塞 CI，真 bug 保持 error 并修掉。**

- 降 warn：`no-explicit-any` / `no-unused-vars` / `no-require-imports` 等
  （存量约定，要求一次改完既不现实也没必要）
- 保持 error 并修复：`react-hooks/rules-of-hooks`——`modelStore.ts` 的
  `getCurrentModelPreset()` 在普通函数里调 zustand hook，属于真 bug（非 React
  上下文调用 hook 本应崩溃；因函数无调用方而未爆雷）。改成
  `useModelStore.getState().model`（zustand 组件外取值的标准写法）

### 3.5 附带：format:check 门禁

CI 有 `prettier --check .`，存量 23 个文件从未格式化过 → `pnpm format` 全量
格式化一次解决。

> **方法论沉淀：CI 的每道门禁，合并前先在本地全量跑一遍。**
> `pnpm lint && pnpm format:check && pnpm typecheck && pnpm build`
> 本地四绿再推，避免一轮 CI 5 分钟一次的试错。

---

## 4. next build 构建期崩溃：模块顶层实例化的通病

### 现象

```
Collecting page data ...
c: Invalid endPoint : undefined
Error: Failed to collect page data for /api/auth/login
```

### 根因

`src/lib/storage/index.ts` 在**模块顶层** `new Client({ endPoint: process.env.MINIO_ENDPOINT! })`。
`next build` 的"Collecting page data"阶段会 import 各 route 模块 → MinIO 构造函数
发现 endPoint 是 undefined 直接 throw → 构建崩溃。本地没 `.env`、CI 也没配业务
密钥，所以两边都必炸。

### 修复模式：惰性单例

```ts
let _client: Client | null = null;
export function getMinioClient(): Client {
  if (!_client) {
    const endPoint = process.env.MINIO_ENDPOINT;
    if (!endPoint) throw new Error('MinIO env is not set: ...'); // 请求期报清晰错误
    _client = new Client({ endPoint, ... });
  }
  return _client;
}
```

所有使用点改成 `getMinioClient().xxx()`；顺带把 `export default minioClient`
（唯一的默认导出使用方 `file-parser.ts`）改为命名导入。

> **通用教训：任何"读环境变量创建连接"的对象都不要在模块顶层实例化。**
> 顶层实例化 = 把"配置缺失"从运行期错误升级成构建期崩溃。
> PG Pool / ioredis 顶层创建不炸是因为它们不校验参数、连接惰性建立——但
> 依赖这个巧合不如统一惰性模式。

---

## 5. 生产编排设计（docker-compose.prod.yaml）

### 5.1 凭证与端口

- 中间件凭证全部 `${VAR:?required}` 插值自 `.env.production`（部署脚本传
  `--env-file .env.production`），`:?` 语法保证缺变量时 compose 直接报错
  而不是带空密码起服务
- 端口策略：仅 `3000` 对外；PG/Redis/MinIO 绑定 `127.0.0.1:端口`——app 走
  compose 内部网络（host 用服务名），运维走 `docker compose exec` 或 SSH 隧道
- Redis 加 `--requirepass`；healthcheck 用 `$$REDIS_PASSWORD`（`$$` 转义给
  容器内 shell 展开，配合 environment 注入）

### 5.2 持久化卷的两个隐蔽 bug（读源码才发现的）

默认落盘路径 ≠ 卷挂载路径，容器重建即丢数据：

| 数据             | 代码默认路径（不在卷上）       | 修复                                                    |
| ---------------- | ------------------------------ | ------------------------------------------------------- |
| 长期记忆         | `~/.deer-flow`（容器内 home）  | `DEERFLOW_DATA_DIR=/app/.memory` + 卷                   |
| MCP/skill 启用态 | `{cwd}/extensions_config.json` | `DEERFLOW_EXTENSIONS_CONFIG_PATH=/app/.data/...` + 新卷 |

这两个环境变量写在 compose 的 `environment:`（结构性保证），而不是 env 文件
（怕运维漏填）。沙箱 `.sandbox` 与 `skills/custom` 默认就在 cwd 下，与卷对齐无需处理。

**教训：挂卷前必须读代码确认真实落盘路径**（`grep DEERFLOW_DATA_DIR` 一分钟的事），
挂错位置等于没挂。

---

## 6. 环境变量体系（.env.production）

### 6.1 密码生成策略

| 变量类型                | 生成方式                  | 原因                                                       |
| ----------------------- | ------------------------- | ---------------------------------------------------------- |
| `AUTH_JWT_SECRET`       | `openssl rand -base64 48` | 不会嵌进 URL，base64 无妨                                  |
| `MODEL_KEY_ENC_SECRET`  | `openssl rand -base64 32` | 同上；**设置后永不可改**（旧密文解不开）                   |
| PG/Redis/MinIO 三个密码 | `openssl rand -hex 24`    | 会嵌进 URL，base64 的 `+/=` 需转义易踩坑，hex 只有字母数字 |

### 6.2 一致性三件套（同一值出现在两处）

```
POSTGRES_PASSWORD  ↔  DATABASE_URL 里的密码
REDIS_PASSWORD     ↔  REDIS_URL 里的密码（redis://:密码@redis:6379）
MINIO_ROOT_USER/PASSWORD ↔ MINIO_ACCESS_KEY/SECRET_KEY
```

原因：compose 用 `POSTGRES_PASSWORD` 等创建服务，应用用 URL 里的密码连接——
两处必须同值。改一处忘另一处 = app 起来连不上库。

### 6.3 从旧部署迁移时的密钥继承（易忽略！）

旧数据里的密文是用旧密钥加密的：

- 迁移账号/模型密钥数据 → `AUTH_JWT_SECRET` **沿用旧值**，别重新生成
- 旧环境没有 `MODEL_KEY_ENC_SECRET` → 新环境**也留空**（代码回退用 JWT secret
  解密，保持兼容）；一旦填了新值，旧密文全部解不开
- 全新起步（不迁数据）→ 随便生成

### 6.4 HTTP 部署的登录陷阱

`NODE_ENV=production` 时登录 cookie 默认带 `Secure` 标志 → **HTTP 访问浏览器
不回传 cookie → 登录永远不生效**。解法：env 里 `DISABLE_SECURE_COOKIE=true`，
上 HTTPS 后删除。

---

## 7. 服务器初始化与构建链路的国内网络必配项

```bash
# ① 装 Docker 本身走 Aliyun 镜像源（download.docker.com 国内超时）
sudo sh get-docker.sh --mirror Aliyun

# ② Docker Hub 拉取走腾讯云内网镜像（postgres/redis/minio/node 基础镜像必拉）
sudo tee /etc/docker/daemon.json <<'EOF'
{ "registry-mirrors": ["https://mirror.ccs.tencentyun.com"] }
EOF
sudo systemctl restart docker
```

③ **Dockerfile 内 `pnpm install` 走 npmmirror**（`ENV npm_config_registry=https://registry.npmmirror.com`）：
Plan B 把 `pnpm install` 挪到服务器上执行后，官方 npm 源在境内几乎不可用——
镜像构建链路里的包管理器源和 Docker daemon 的 registry mirror 是两回事，各配各的。

> 境内服务器跑构建的完整清单：docker 安装源 + daemon registry mirror + 包管理器源，
> 三个都要对，缺一个就在某个环节卡死。

---

## 8. SSH 通道从零打通（含完整排障实录）

这是整个流程中坑最密的一段，实录如下（每一步的"现象→根因→动作"都值得复用）：

### 8.1 事件线

| #   | 现象                                         | 根因                              | 定位/修复                                            |
| --- | -------------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| 1   | scp 报 Permission denied + 要密码            | 在**服务器**上跑了 Mac 路径的 scp | 认清命令该在哪台机器跑                               |
| 2   | vim 编辑 env 报 E212: Can't open for writing | `/opt` 目录 sudo 建的属 root      | `sudo chown -R ubuntu:ubuntu /opt/mini-deepresearch` |
| 3   | 装好公钥后 ssh 仍要密码                      | **IP 打错一位**，连的是别人的机器 | 见 8.2 的方法论                                      |
| 4   | （前置怀疑）公钥粘贴损坏 / 权限不对          | 排查后排除                        | `ssh-keygen -lf` 指纹比对 + `ls -ld` 权限三连        |
| 5   | drone-scp 报 `ssh: no key found`             | `SSH_KEY` Secret 粘成了**公钥**   | 私钥以 `-----BEGIN OPENSSH PRIVATE KEY-----` 开头    |

### 8.2 SSH 排障三板斧（可复用套路)

**第一板斧：客户端 verbose 看认证过程**

```bash
ssh -i ~/.ssh/deploy_key -o IdentitiesOnly=yes -v ubuntu@<IP> 'echo ok' \
  2>&1 | grep -E 'identity file|Offering|refused|denied|Authentications|passphrase'
```

输出解读：

- 无 `identity file` 行 → 本地私钥文件不存在（`ssh -i` 不报错直接跳到密码！）
- `Offering public key` 后跟 `Server accepts key` → 通了
- `Offering public key` 后仍 `Authentications that can continue` → 服务器拒绝，去第二板斧
- 提示 `Enter passphrase for key` → 要的是**密钥口令**不是服务器密码

**第二板斧：指纹比对（一眼定位"钥匙对不对"）**

```bash
# 客户端：看私钥指纹（verbose 输出里也有）
ssh-keygen -lf ~/.ssh/deploy_key.pub
# 服务器：看 authorized_keys 里各公钥指纹
ssh-keygen -lf ~/.ssh/authorized_keys
```

两边 SHA256 指纹一致 → 内容没粘坏，问题在配置层；不一致 → 重新装公钥。

**第三板斧：服务器 auth.log 看拒绝原因**

```bash
sudo grep sshd /var/log/auth.log | grep -v <扫描器IP> | tail
```

- `bad ownership or modes` → 目录权限（home 不能组可写、.ssh 700、authorized_keys 600）
- `account is locked` → 从没设过密码的账户可能被锁，`sudo passwd -u ubuntu`
- **日志里压根没有自己的连接记录** → 强烈怀疑连的不是这台机器（IP/NAT/打错字）

> 公网服务器 auth.log 里永远有陌生 IP 爆破 root 的记录（背景噪音），别被带偏，
> `grep -v` 掉再分析。

### 8.3 免 scp 的替代方案（减少剪贴板事故）

不依赖 Mac↔服务器传输，直接在**服务器上**生成密钥对并程序化追加：

```bash
ssh-keygen -t ed25519 -C "deploy" -f ~/deploy_gh -N ""
cat ~/deploy_gh.pub >> ~/.ssh/authorized_keys   # 程序化追加，无粘贴损坏风险
cat ~/deploy_gh                                  # 私钥全文 → 粘贴进 GitHub Secret
```

GitHub Actions 只需要私钥文本，Mac 本地可以完全不持有密钥。

### 8.4 私钥 vs 公钥（一秒区分）

```
-----BEGIN OPENSSH PRIVATE KEY-----   ← 私钥（进 SSH_KEY Secret）
ssh-ed25519 AAAAC3Nza... deploy       ← 公钥（进 authorized_keys）
```

---

## 9. 旧部署退役（pm2 手动跑 → CI 自动部署）

旧形态：clone 仓库 + pm2 跑 `npm start`（next-server），基础设施非容器或已停。

```bash
# 确认谁占着端口（新栈需要 3000/5432/6379/9000/9001 全空闲）
sudo ss -tlnp | grep -E ':(3000|5432|6379|9000|9001) '

# pm2 管的进程别 kill PID（会复活），用：
pm2 stop all && pm2 delete all && pm2 kill   # delete 防止开机 resurrect
# docker compose 起的旧栈：docker compose down（切记不带 -v，卷里有数据）
```

**教训：pm2/systemd 管的进程，先看进程树（`pstree -ps <PID>`）再动手**，
按 PID kill 大概率被拉起。

---

## 10. 排查方法论总结（跨场景通用）

1. **CI 挂了先本地复现**——四道门禁全部本地可跑，一轮 CI 要 5 分钟，本地 1 分钟
2. **剥洋葱**：一个报错修完才露出下一层（eslint：后缀→形态→版本→存量），预期多层问题别指望一发入魂
3. **配置文件"存在"≠"生效"**：husky 要 install 激活、Secret 要内容正确、gitignore 会吞文件——每层都要验证激活状态
4. **连不上先确认连的是谁**：IP、DNS、端口，`auth.log` 无自己记录 = 高危信号
5. **密钥类问题先验内容再验配置**：指纹比对（ssh-keygen -lf）比肉眼检查可靠一百倍
6. **挂卷前读代码确认真实落盘路径**；**构建期崩溃先查模块顶层副作用**
7. **每修一层就本地全量验证**，攒一波再推 CI

---

## 11. 遗留事项与改进方向

| 事项                            | 现状                                 | 建议                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI 无 commitlint                | 本地钩子可 `--no-verify` 绕过        | quality job 加遍历 push commits 的校验                                                                                                                                                                            |
| SSH 暴露公网                    | auth.log 持续有爆破记录              | fail2ban / 安全组收窄来源                                                                                                                                                                                         |
| HTTP 明文                       | `DISABLE_SECURE_COOKIE=true`         | 域名 + HTTPS（Caddy 自动证书最省事）                                                                                                                                                                              |
| ~~镜像走 tar 传输（scp 卡死）~~ | **已解决（Plan B）**：服务器本地构建 | 两个镜像分发方案先后死于跨境线路：① scp 传 tar 20 分钟 0 字节；② TCR push 层全部推完但 manifest PUT 稳定挂起（timeout + 重试 5 次无果）。终态：CI 只传 ~0.5MB 源码包，docker build 全在服务器本地，零跨境镜像流量 |
| 回滚深度 = 1                    | `.previous-image` 只存一版           | 历史镜像都在服务器本地，手动可回任意版                                                                                                                                                                            |
| `pnpm install` 走官方源         | 国内极慢（实测 5 分钟+）             | `.npmrc` 固定 npmmirror                                                                                                                                                                                           |

---

## 12. 关键命令速查

```bash
# ── 本地 ──
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build   # CI 门禁本地全量预演
git config core.hooksPath && ls .husky/_                          # 验证 husky 激活

# ── CI 产物验证（服务器）──
cd /opt/mini-deepresearch
docker compose --env-file .env.production -f docker-compose.prod.yaml ps
docker compose --env-file .env.production -f docker-compose.prod.yaml logs --tail=100 app
bash scripts/rollback.sh                                          # 手动回滚上一版

# ── compose 改动验证（本地，不碰服务器）──
printf 'POSTGRES_PASSWORD=x\nREDIS_PASSWORD=y\nMINIO_ROOT_PASSWORD=z\n' > /tmp/t.env
touch .env.production                                             # env_file 需要
docker compose --env-file /tmp/t.env -f docker-compose.prod.yaml config   # 看插值结果

# ── SSH ──
ssh -i ~/.ssh/deploy_key -o IdentitiesOnly=yes -v ubuntu@<IP> 'echo ok'
ssh-keygen -lf ~/.ssh/authorized_keys                             # 指纹比对
sudo ss -tlnp | grep -E ':(3000|5432|6379|9000|9001) '            # 端口占用
```
