# 真实用户系统改造方案

把当前「个人部署形态」的账号体系升级为可对外开放的真实用户系统。本文是分阶段实施的设计文档；现状盘点基于代码审计（行号为方案编写时点），每阶段按项目分阶段提交约定独立 commit。

已定决策（2026-10-08）：

- **部署形态：前后端分离**——前端独立域名（app 域）+ API 独立域名（api 域），浏览器真跨域访问
- **注册策略：开放注册 + 加固**——限流防爆破、注册开关、可选邮箱验证/找回密码
- **OAuth：GitHub / Google / QQ** 三平台登录
- **机器调用：个人访问令牌（PAT）**——Bearer Token + scopes + 吊销

## 一、目标形态

| 维度       | 目标                                                                                   |
| ---------- | -------------------------------------------------------------------------------------- |
| 传输       | 双域 HTTPS（nginx 终结 TLS）+ 安全响应头                                               |
| 浏览器会话 | HttpOnly cookie `SameSite=None; Secure` + CORS 精确 origin 白名单 + Origin 校验防 CSRF |
| 登录       | 邮箱密码（开放注册 + 加固）+ GitHub / Google / QQ OAuth                                |
| 机器调用   | PAT（sha256 存储、明文只回显一次、scopes、吊销）                                       |
| 模型密钥   | 仍 per-user 加密存储，扩展为多 Key + 自定义端点                                        |
| 管理       | admin 用户管理、用量统计、审计日志                                                     |

## 二、现状盘点（审计结论）

### 2.1 账号与鉴权

- 邮箱+密码注册/登录已可用：bcryptjs（SALT_ROUNDS=10，`src/deerflow-harness/auth/password.ts`）、强密码校验、JWT HS256（payload `{sub, ver, iat, exp}`，默认 7 天，`src/deerflow-harness/auth/jwt.ts`）
- Cookie `access_token`：httpOnly + SameSite=lax + secure（生产且未设 `DISABLE_SECURE_COOKIE`），`src/server/http/auth.ts:22-33`
- 改密经 `users.token_version` +1 全端下线；每次请求实时查 users 表（无缓存）

缺口：

- OAuth 是 501 占位（`src/app/api/auth/oauth/[provider]/route.ts:9-15`）
- 注册永久开放（无开关/验证码/邮箱验证），`/api/auth/register` 角色硬编码 'user'
- 零防爆破：`src/server/http/rate-limit.ts:15` 是 noop 占位，所有路由未接限流
- 无忘记密码/重置流程；登出只清 cookie，无服务端撤销；无 refresh token
- 前端无全局 401 处理（`src/utils/request/api.ts:61-63` 只 throw），会话过期用户无感
- admin 角色空壳：无管理 API、无权限分支，systemRole 仅前端展示
- 无迁移框架：DDL 内联 `src/lib/db/index.ts:184-200`，靠 `alter if not exists` 拼接演进

### 2.2 跨域与部署

- **零 CORS**：全仓无 `Access-Control-*` / OPTIONS 处理 / headers 配置；同源部署（IP:3000），前端 API 基址写死相对路径（`src/utils/request/api.ts:133` 单例 `/api`，SSE 同）
- **无 TLS**：生产靠 `DISABLE_SECURE_COOKIE=true`（`docs/deploy-runbook.md` 已注明上 HTTPS 后删除）
- 无 nginx 配置（仓库内）；无任何安全响应头（CSP / X-Frame-Options / X-Content-Type-Options 全零）
- SSE 用 fetch + `credentials:'include'`（`src/events/client/create-agent-event-stream.ts:72-82`）——天然支持 CORS，无需改 EventSource

### 2.3 密钥体系

- 用户模型 Key：AES-256-GCM（随机 IV，`src/lib/crypto/model-key-crypto.ts`），主键 `(user_id, provider)` 即每用户每 provider 一把（`src/deerflow-harness/auth/user-model-key-repository.ts:41-60`）；主聊天链路经 `resolveUserModelConfig()` 只读用户 Key、不读环境默认 Key（`src/server/services/model-config-service.ts`）

缺口：

- `MODEL_KEY_ENC_SECRET` 缺失时回退 `AUTH_JWT_SECRET`（`model-key-crypto.ts:40-52`）——共享密钥放大面
- 每 provider 仅 1 把 Key：无轮换/备用/命名
- provider/模型白名单硬编码（`src/config/models.ts:23-88`，7 预设 5 provider），用户不能自定义 baseURL
- 副链路（标题/记忆/OCR/embedding/Tavily）全走服务器 env Key，多用户共享配额
- 无用量/配额/审计

### 2.4 越权面（独立安全债）

- threads v1 REST（`src/app/api/threads/**`）用 `x-user-id` 透传头（`auth:'none'` + userIdHeader）：无签名、空值放行；`src/deerflow-harness/persistence/thread-meta/postgres-store.ts:161-169` 的 assertOwner 对空 user_id 直接放行——匿名可操作匿名行甚至他人 thread。前端不调用这些 REST 路由（只消费 SSE stream）
- `files/upload`、`files/delete` 是 `auth:'none'`：仅靠 middleware 的 cookie 存在性弱门禁；上传无归属绑定、删除无归属校验
- middleware 只查 cookie 存在性不验签（`src/middleware.ts`，验签在路由层）

## 三、分阶段计划

每阶段含目标 / 改动点 / 验收；工作量粗估为单人天，供排期参考。依赖链：`0 → 1 → (2 ∥ 3) → 4 → 5/6`。

### Phase 0 — 地基与安全基线（1-3d）

目标：HTTPS/nginx/安全头/迁移框架就位，越权面清零。`SameSite=None; Secure` 跨域 cookie 的物理前提。

改动点：

1. nginx：两个 server 块（app/api 域）、TLS 终结、HSTS、SSE 路由 `proxy_buffering off` + 读超时调大；`docker-compose.prod.yaml` 不再裸暴露 3000；runbook 删除 `DISABLE_SECURE_COOKIE`
2. 安全响应头：X-Content-Type-Options / X-Frame-Options / Referrer-Policy 在 api-handler 统一加；CSP 放前端，report-only 起步（AntD 需 `style-src 'unsafe-inline'`）
3. 迁移框架：`src/lib/db/index.ts` 的 inline DDL 改轻量 runner（`schema_migrations` 表 + 编号 SQL），后续全部新表走迁移——后面 6 个阶段要加 6 张表
4. 越权面修复：files/upload + delete 改 cookie 鉴权，`file_metadata` 补 user_id 归属并在删除时校验；threads v1 切 cookie 鉴权 + 修 assertOwner（外部 harness 调用方在 Phase 4 用 PAT 覆盖）

验收：双域 HTTPS 可访问；未登录调 files/upload 得 401；匿名读不到他人 thread；安全头齐全。

### Phase 1 — 前后端分离 + CORS（2-3d）

目标：锁定目标拓扑，后续全部功能在真实跨域形态上验收，避免同源验收一遍、跨域再验收一遍。

改动点：

1. CORS 层（`src/server/http/api-handler.ts`）：`CORS_ALLOWED_ORIGINS` 精确 origin 白名单（禁通配）、OPTIONS 预检、`Allow-Credentials: true`；两条 SSE 路由（v3/chat、threads streams）的 Response 手动补同一组头
2. Cookie 改 `SameSite=None; Secure`（`src/server/http/auth.ts`）
3. CSRF 显式化：lax 的同站保护失效 → 服务端对非 GET 校验 `Origin ∈ 白名单`（与 CORS 用同一处单一出处）
4. 前端 API 基址：`api.ts` 单例、SSE endpoint、`utils/auth/client.ts` 改从基址组装；注入方式待定（见四、决策记录）
5. OAuth 回跳预留：redirect target 校验 origin 白名单（Phase 3 直接用）

验收：app 域登录 → 跨域 POST `/api/v3/chat` 带 cookie → SSE 流正常 → 上传/图片正常；第三方 origin 被 CORS 拒绝。

风险：SSE 过 nginx 必须关 buffering；web（只出页面）/ api（只出 /api）两个 Next.js 实例共用同一镜像不同 env。

### Phase 2 — 账号加固（3-5d，可与 Phase 1 并行开发）

目标：开放注册的防滥用前提；真实用户的找回密码、会话撤销、过期体验。

改动点：

1. 限流实装（`src/server/http/rate-limit.ts`）：Redis 固定窗口；login / register / initialize / change-password / demo-login 全接入；IP + 账号失败计数双维度，连续失败锁定
2. 注册开关 `REGISTRATION_ENABLED`（默认开）+ setup-status 下发，前端登录页联动
3. 邮箱验证 + 忘记密码（依赖 SMTP，见决策记录）：verify_tokens / password_reset_tokens 表 + 发信服务 + 重置页；SMTP 未配置时注册直接通过（限流兜底）
4. 会话表：`sessions(id, user_id, expires_at, revoked_at)` + JWT payload 加 `sid`；getCurrentUser 校验 sid 未吊销（已有每请求查库，无新增成本类别）；logout 改服务端吊销；改密仍走 `tokenVersion` 全端下线
5. 前端全局 401：ApiClient / AuthProvider 收 401 → 清 user → 跳 /login

验收：同 IP 狂试登录被限流/锁定；登出后旧 JWT 立即失效；忘记密码全流程；会话过期自动弹回登录页。

### Phase 3 — OAuth：GitHub / Google / QQ（4-6d）

改动点：

1. 表 `oauth_accounts(user_id, provider, provider_user_id, unique(provider, provider_user_id))`
2. 通用 provider 框架：authorize → code → token → userinfo；state 用 httpOnly cookie 防 CSRF；回调回跳走 Phase 1 的 origin 白名单防 open redirect
3. 三平台对接——QQ 互联流程特殊：token 后要先 `get_openid` 再取用户信息，注意 openid 与 unionid 语义
4. 账号绑定策略：provider_user_id 命中 → 登录；email 命中已有账号 → 要求登录确认绑定（防账号抢占）；否则建号自动绑定
5. 前端 `src/app/(auth)/login/page.tsx` 加三个按钮；回调在 api 域完成后 302 回 app 域

验收：三平台新老用户登录、绑定冲突确认、回调 origin 校验生效。

### Phase 4 — API Token / PAT（2-3d）

改动点：

1. 表 `api_tokens(id, user_id, name, token_hash, prefix, scopes, expires_at, last_used_at, revoked_at)`；明文只在创建时回显一次
2. withApiHandler 增加 `auth: 'bearer'`：Authorization Bearer → sha256 查表 → ctx.user；scope 检查 helper
3. threads v1 的 `x-user-id` 正式废弃（被 PAT 取代）；v3 聊天、沙箱等主链路支持 Bearer
4. 前端「设置-API Token」管理页（生成/列表/吊销）
5. 限流与审计按 token 记录

验收：脚本带 PAT 跑通建 thread → submit run → 读 stream；吊销立即失效；无 token 401。

### Phase 5 — 密钥体系深化（3-5d）

目标：真实多用户下每 provider 一把 Key 不够（轮换/备用）；BYOK 需要自定义端点；副链路共享配额不透明。

改动点：

1. 多 Key：`user_model_keys` 去掉 `(user_id, provider)` 主键语义 → 加 id + name + is_default + enabled；service 与前端从「provider 分组」改「Key 列表」
2. 自定义端点：用户可填 baseURL/modelName（OpenAI 兼容）——必须加 SSRF 校验（禁内网/环回地址）；预设保留为快速入口
3. 副链路语义：标题/记忆/OCR/embedding 现在全走服务器 env Key——改为用户已配该 provider Key 时用用户 Key，否则 env 兜底；至少先做记忆 + 标题两条
4. 去掉 `MODEL_KEY_ENC_SECRET` → `AUTH_JWT_SECRET` 的回退，强制独立 secret

验收：单用户同 provider 多 Key 切换；自定义 endpoint 生效且 `127.0.0.1` 被拒；未配 Key 用户的副链路回落 env。

### Phase 6 — 用户管理与审计（3-5d）

改动点：

1. admin 门禁：withApiHandler 加 `requireRole('admin')`，systemRole 从「只展示」变真门禁
2. 管理 API + 页面：用户列表 / 禁用（`disabled_at` + getCurrentUser 校验，即时踢下线）/ 删除 / 重置密码 / 改角色；注册开关可改为 admin 可调
3. 用量：`usage-accounting.ts` 的 ALS 累加器已有——加 per-user 日用量表 + 配额（软限/硬限）
4. 审计：登录 / 注册 / Key 变更 / PAT 操作 / 管理操作入 `audit_logs`

验收：禁用用户后其会话即时失效；用量按用户可查；关键操作有审计轨迹。

## 四、决策记录

已定：

- 前后端分离（真跨域，浏览器 cookie + CORS）
- 开放注册 + 加固
- OAuth = GitHub / Google / QQ
- 需要 PAT

实施时拍板：

- **SMTP 有没有**——决定 Phase 2 邮箱验证/找回密码的时点；没有就先做限流 + 注册开关，验证与找回延后
- **前端基址注入方式**——运行时注入（layout 服务端读 env 输出 `window.__API_BASE__`，单镜像免双构建，推荐）vs `NEXT_PUBLIC_*` 双构建
- **threads v1 REST 是否还有外部调用方**——没有的话 Phase 0 直接切 cookie 鉴权，零兼容负担
- **自定义 baseURL 开放范围**——建议仅限可信用户或域名白名单（SSRF 是真实风险）

## 五、依赖与风险

- 跨域 cookie 必须 HTTPS 先行：Phase 0 是 Phase 1 的硬前提，顺序不可换
- SSE 跨域过 nginx：buffering 关闭 + 超时配置，压测验证长连接
- 跨域 SSE 若在真实环境不可行：nginx 反代 `/api` 回同源是零代码回退方案（CORS 基建保留不白做）
- QQ 互联的 openid/unionid 语义差异，三平台回调流程需逐一实测
- 双实例部署（web/api）后，`middleware.ts` 的页面跳转逻辑只在 web 实例生效，api 实例按 401 JSON 处理
