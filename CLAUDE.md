# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 项目概览

**Mini-DeepResearch** 是基于 **Next.js 14 + LangChain/LangGraph 1.x** 的多智能体对话应用：

- **单一 lead-agent 形态**（对齐 deer-flow 2.0）：lead 永远具备 subagent 能力（`task` 工具 + general-purpose subagent），由 agent 自主判断「简单直接答 / 复杂分解为并行 subagent」，没有「联网搜索 / 深度研究」档位
- 多模型对话（MODEL_PRESETS 预设：Qwen Max/Turbo、DeepSeek v4 Flash/Pro、OpenAI 4o、Moonshot v1、GLM-5.3 Flash，见 `src/config/models.ts`）
- 用户认证（JWT + OAuth）；模型 API Key **按用户**加密存 DB（`model-keys` + `MODEL_KEY_ENC_SECRET`），主聊天链路经 `resolveUserModelConfig()` 取用户 Key，**不读环境变量默认 Key**（环境 Key 只剩标题 / 提示词增强 / 记忆更新等副链路兜底）
- 持久化：PostgreSQL（threads/runs 元数据 + LangGraph checkpoint）+ Redis（缓存 / 跨进程沙箱协调）+ MinIO（文件）
- SSE 事件流：fire-and-forget 执行 + 事件缓冲回放（多进程下经 Redis Stream 镜像跨进程续读）；LLM 驱动长期记忆；文件上传解析（PDF/Word/图片 OCR）；视觉多模态；可插拔沙箱（local/docker/remote）；MCP/skill 扩展；双层背压并行编排

技术栈：前端 Next.js 14 / React 18 / Ant Design 5 / Zustand / TailwindCSS；后端 Node.js + LangChain/LangGraph；AI 走 OpenAI 兼容接口；存储 PostgreSQL / Redis / MinIO；搜索 Tavily。

## 常用命令

```bash
pnpm install            # 依赖（激活 husky）
pnpm dev                # Turbopack 开发服务器 http://localhost:3000
pnpm build && pnpm start
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test   # CI 门禁本地等价命令
pnpm format             # prettier --write
pnpm bench:qa           # 研究 QA 基准
pnpm bench:longmem:ingest && pnpm bench:longmem  # LongMemEval 两阶段：先预写记忆再评测
docker-compose up -d    # 本地基础设施（PostgreSQL + Redis + MinIO）
```

**单元测试（vitest）**：`pnpm test` 跑 `src/**/__tests__/**/*.test.ts`——测试与被测代码同域、收在 `__tests__/` 子目录（include 白名单只在 `__tests__` 下，平层 `.test.ts` 不会被跑）。

**提交校验（husky，需先 `pnpm install` 激活）**：`pre-commit` lint-staged（eslint --fix + prettier）；`commit-msg` commitlint（Conventional Commits；中文 subject 已放宽，type-enum 见 `commitlint.config.mjs`）。

## CI/CD 自动部署

push main 触发 `.github/workflows/deploy.yml`（目标腾讯云 Ubuntu `/opt/mini-deepresearch`）：

- **job quality**：lint / format:check / typecheck / test / build（PR 也跑）
- **job deploy**（仅 push main 且改动含非文档文件）：`git archive`（~0.5MB）→ scp → **服务器本地 `docker build`**（`scripts/deploy-remote.sh`）→ compose 起服务 → 健康检查（`/api/auth/setup-status`，30×3s，<500 即存活）→ 失败自动回滚 `.previous-image`

关键约束（踩坑实录与排查见 `docs/cicd-notes.md`）：

- **纯文档改动（`**.md`/`docs/**`）连流水线都不触发**：过滤写在 `on.push.paths-ignore`（触发层）。**不要改回 job 内判定**——dorny/paths-filter 在浅克隆 `fetch-depth: 1` 下算不出 push 的 diff，会退回「匹配」而失效；且全量构建会和 PG/Redis/MinIO/app 抢内存（2026-09 曾把整机压死）
- **资源边界**：Dockerfile builder `NODE_OPTIONS=--max-old-space-size=2048`；deploy-remote.sh 构建前磁盘守卫（<3G 先清缓存）+ 成功后回收（构建缓存留 2G、镜像留最近 3 版）；compose 全部服务日志轮转 `max-size 10m / max-file 3`
- **镜像不在 CI 构建、不走 registry**（跨境 scp 镜像 tar 与推 TCR 实测不可用）：服务器本地构建（国内源已配）；tag `deepresearch:<git sha 前 12 位>`，历史镜像服务器本地可手动回滚
- 密钥分层：GitHub Secrets 只放 4 个 SSH 凭证；业务密钥只在服务器 `DEPLOY_PATH/.env.production`（compose 经 `--env-file` 插值，`:?` 强制非空）
- **解包是干净同步（tar 覆盖解包只加不删，会残留已删除文件）**：CI 解包先对比新树与工作目录文件清单，删除白名单（`.env.production` / `.previous-image`）之外的遗留文件再覆盖——否则上次部署的死文件混进 docker build 上下文，报「模块无导出」这类幽灵 typecheck（见 `docs/cicd-notes.md` §12）

文档分工：`docs/deployment.md`（设计）→ `docs/deploy-runbook.md`（操作）→ `docs/cicd-notes.md`（踩坑与排查）。

## 环境变量

完整清单见 `.env.example`（鉴权、模型密钥加密、Docker/Remote 沙箱的全部 `DEERFLOW_*` 项）。关键项：

- `DATABASE_URL` / `REDIS_URL` / `MINIO_*`——基础设施（账密端口与 `docker-compose.yaml` 一致）
- `MODEL_KEY_ENC_SECRET`——用户模型 Key 加密密钥，一旦设置不可更改
- `ZHIPU_API_KEY`——智谱（GLM 预设 / 图片 OCR / embedding 共用）；无 Key 时 OCR 返回占位文本、语义检索回落词面
- `DEERFLOW_SANDBOX_BACKEND`——local（默认，宿主直连）/ docker（每线程加固容器）/ remote（每线程 SSH）；`DEERFLOW_ALLOW_HOST_BASH` 只门控 local（docker/remote 是隔离边界）
- `DEERFLOW_MAX_CONCURRENT_RUNS`（run 级闸门，默认 16）/ `DEERFLOW_DOCKER_MAX_LIVE_CONTAINERS`（容器级闸门，默认 32）
- `DEERFLOW_GRACEFUL_DRAIN_MS`——优雅停机排水窗口（默认 30000）
- `NEXT_MANUAL_SIG_HANDLE=1`——多进程部署必须置位：关掉 Next 自带 SIGTERM 清理（server.close → exit(0)），否则排水序列跑不到第一步
- `DEERFLOW_VISION_MAX_IMAGE_MB`——单图上限（默认 5）；**前端 `MAX_IMAGE_SIZE_MB` 必须 ≤ 它**，否则「发送成功但模型没看到图」静默降级
- `DEERFLOW_GUARDRAIL_ENABLED` / `DEERFLOW_GUARDRAIL_BLOCK`——规则式护栏（默认开，仅告警）
- `STREAM_BRIDGE_BUFFER_MAX` / `DEERFLOW_DATA_DIR` / `DEERFLOW_EXTENSIONS_CONFIG_PATH` / `DEERFLOW_SKILLS_DIR` / `DEERFLOW_SANDBOX_DIR`

> 模型预设不再依赖 `OPENAI_MODEL_NAME`：默认预设 `deepseek-v4-flash`，各 provider baseUrl 内置默认（对应 `*_BASE_URL` 环境变量可覆盖）；主聊天链路用用户 Key，环境 Key 仅供副链路兜底。

## TypeScript 路径别名

```
@/*                  →  ./src/*
@deerflow-harness/*  →  ./src/deerflow-harness/*
```

## 注释约定（`src/**`）

注释只解释**这段代码在做什么、为什么这样设计**（不变量、顺序约束、取舍、反直觉写法的依据），不写它是**怎么来的**——过程性叙述会随代码变化而失准，且 git 与 `docs/` 已各司其职。

**砍掉**——历史演进（「旧实现会先落下孤儿行」「自 X 重构起废弃」）、事故与调试过程（「曾把整机压死」「排查时发现」，含日期与复盘结论）、决策语境（「已决定不落盘」「按某某要求」）、外部指涉。

**保留**——可验证的证据本身，去掉取得它的过程：

```ts
// ✅ 用 includes 而非 startsWith：取消原因可能被中间件链包一层前缀
// ✅ 阈值取 0.6：无关文本余弦落在 0.44~0.55，真相关 0.64~0.69
// ✅ 不能用 ContentBlock.Multimodal.Image：会被原样透传给 provider 并 400
// ❌ 「实测发现」「我们试过」「上次调试时确认」——证据留下，取得证据的过程去掉
```

写不下又值得留的过程性内容归 `docs/`（`docs/cicd-notes.md` 就是踩坑实录），不在代码注释里复述。存量注释**不回扫**，按「碰到再改」自然演进；`docs/**` 与本文件不受此约定约束。

## 整体架构

```
前端（React/Next.js + Zustand + EventBus）
   │ HTTP + SSE
API Routes（controller，withApiHandler 统一管线）
   │
Services（src/server/services，领域编排，无 SQL）
   │                       │
DAOs（单表 SQL）      ThreadService（wiring 进程单例，9 操作）
   │                       ├─ DeerFlowClient（Agent 缓存 + LangGraph stream）
   ▼                       ├─ Checkpointer（PG）/ Stores（threads/runs）
PostgreSQL                 └─ RunEventBus（进程内 StreamBridge / Redis Stream 镜像 + 游标续读）→ SSE → 前端
```

Agent 执行流水线：`RunConcurrencyGate`（run 级并发闸门）→ `createBaseAgent()`（中间件链按 `ORDERED_MIDDLEWARES` 位序装配）→ 工具（search_web / task / sandbox 读写执行 / view_image / …）→ `SandboxProvider`（local / docker / remote）。

## 核心组件

### 1. API 路由层

全部 35 条路由走 `src/server/http/api-handler.ts` 的 `withApiHandler(options, handler)` 统一管线：try/catch 全包裹 → auth（缺省 cookie=getCurrentUser；null → 401）→ guard（sandbox token 等非用户主体门禁）→ userIdHeader（threads 的 x-user-id → `ctx.userId`）→ rateLimit（占位 no-op）→ body/query zod 解析 → `handler(ctx)`。每条返回路径记一条 `[http]` 完成日志；catch 先 `logHttpError` 再 `toHttpError(e, fallbackMessage)`。**约定：wrapper 是 body 唯一读取方**（handler 内不得再调 `request.json()/formData()`）；错误响应统一 `{code,message}`；成功 envelope 逐路由冻结；SSE 两路由（v3/chat、threads streams）直接 `new Response(createSseStream(...))`；`runtime='nodejs'` / `force-dynamic` 留在各自 route.ts 原地。

#### `POST /api/v3/chat`（主聊天接口）

**文件：** `src/app/api/v3/chat/route.ts`。三阶段管线（编排在 chat-service，路由只做 prepare → submit → streamEvents 串联）：

1. **prepare（preflight 全序列，顺序即不变量）**：inputText 校验 → `resolveFilesByIds` → 组装 `images` → **模型预检**（`resolveUserModelConfig`，失败 400 引导去「设置-模型管理」；置于建会话之前，防空会话）→ 确保会话行存在 + 幂等创建线程 → recall/reEdit 截断 → 写 user message → 预生成 `assistantMessageId`。
   会话行两条路径都经 `ensureSession()`——缺省时新建（UUID），传了 `sessionId` 则「有就复用、没有就补建」。**不能**退回「只在没传 sessionId 时建行」：前端首个请求失败（未收到 START）时不会重置本地状态，下一轮会把本地临时 UUID 当「已有会话」发过来；旧实现会先落下 `threads_meta` 孤儿，紧接着 `chat_message.session_id` 外键失败 500，run 永远起不来。会话属于他人时抛 `ChatSessionAccessError` → 403。
2. **submit（fire-and-forget）**：`submitRun()` / `resume()` 立即返回 `run_id`，Agent 后台异步执行。
3. **streamEvents + createSseStream**：先 `yield` START 帧（携 `run_id` / `thread_id` / `chatSession` / `userMessageId` / `assistantMessageId`），再转发 StreamBridge 订阅事件；`AssistantPartsCollector` 同步收集本轮 assistant parts，在生成器 **finally** 里落库（含「用户已取消」标记补写）。整个生成器**必须**整体传给 `createSseStream(request, events)`——abort 的 break 触发 `generator.return()` 才会执行 finally；改成「流结束后路由层 await 落库」会在 abort 路径丢持久化。

请求体：

```typescript
interface ChatStreamBody {
  sessionId?: string; // 缺省 = 新建会话；存在 = 已有会话
  configuration?: {
    model?: { value?: string }; // 显式指定 MODEL_PRESETS 预设；不传回落用户落库的 selectedModel
    memoryEnabled?: boolean; // 单次请求覆盖服务级记忆开关
    memoryMode?: 'inject' | 'retrieve'; // 单次请求覆盖记忆注入模式
  } | null;
  message: {
    contents: Array<
      | { type: 'text'; text: string }
      | { type: 'file'; fileId: string }
      | { type: 'image'; fileId: string }
    >;
  };
  stream?: true;
  operation?: 'resume' | 'recall' | 'reEditCall'; // 续跑人工中断（携带 HumanDecision）/ 重发 / 编辑后重发
}
```

预设与该 provider 的用户 Key 任一缺失 → 400（`no_model_selected` / `no_api_key`）。运行期开关只影响本次 Agent 行为，不修改 baseOptions。

#### 其他路由（全量 35 条见 README「主要 API」）

- `/api/threads` POST/GET——创建线程；分页列表（?limit=&offset=&status=）
- `/api/threads/[threadId]` GET/DELETE——获取详情（可附带 checkpoint）；删除
- `/api/threads/[threadId]/runs` POST/GET——提交 run（fire-and-forget，202 返回 `run_id`）；列出线程下的 run
- `/api/conversations/cancel_run` POST——取消正在跑的 run（用户点「停止」）；幂等，无可停时返回 `cancelled: 0`
- `/api/conversations/update_session` POST/DELETE——重命名 / **整体删除**：`chat_session` + `chat_message` + MinIO 文件对象与 `file_content` + agent 侧数据（`threads_meta` / `runs` / checkpoint / 沙箱容器）——后两类是 commit 后的尽力清理，失败只告警
- `/api/files/upload` POST、`/api/files/delete` DELETE——multipart 上传，存 MinIO 并解析内容（图片走 OCR）；删除

其余 memory / model-keys / mcp / skills / tools / prompt / sandbox/stats / auth 族见 README。

### 2. 后端分层规范

API 层按 controller / service / dao 三层分离，全部位于 `src/server/`（harness 保持不动）：

- 控制器 `src/app/api/**/route.ts`——薄路由：鉴权 → zod 解析 → 调 service → 映射响应
- 服务 `src/server/services/`——领域编排、业务规则、错误映射（AppError）；无 SQL
- DAO `src/server/daos/`——单表 SQL（app 侧四张表）；沿用 harness Store 惯例

**依赖方向**（eslint `no-restricted-imports` 已固化 harness 一侧）：

```
route.ts → @/server/http + @/server/validation + @/server/services（禁止 import @/server/daos）
services → @/server/daos + @/lib + @/deerflow-harness + @/server/wiring
daos    → @/lib/db + @/types + @/utils/common
harness → 永不 import @/server 或 @/app（反向 import 会 lint error）
```

- DAO 方法带可选 `db?: SqlExecutor`：传了走事务连接，不传走 `@/lib/db` 的 `query`。BEGIN/COMMIT/ROLLBACK 只出现在 `daos/shared.ts` 的 `withTransaction()`，DAO 自身不开事务。零参构造、无状态（池在 lib/db 的 globalThis）、不设单例
- service 工厂 `createXService(deps?)` + 模块级懒单例 `getXService()`——无跨请求可变状态，模块级单例即可；**只有 wiring.ts 需要 globalThis**
- `chat-session/types.ts`、`file-metadata/types.ts` 头注释写明：harness 的 `title-middleware`（写 chat_session.title）与 `thread-data-middleware`（读 file_metadata）绕过本 store 直接 SQL，改表结构必须同步检查这两处
- `waitRunError` 不建 DAO：复用 harness `PgRunStore.get()`，轮询循环在 chat-service
- 错误与响应：`toHttpError(e)`——AppError → 其 status；带 `code` 的 Error（ThreadServiceError / ChatSessionAccessError 等）→ 查 `ERROR_STATUS` 表；zod → 400 `INVALID_INPUT`；未知 → 500 `{code:'INTERNAL'}`。**zod v4 错误对象是 `error.issues`**（非 v3 的 `errors`）。宽松 schema 是刻意的：收紧校验会改变状态码（memory 非法 category 回落默认、auth 邮箱不校验走 401）——领域规则在 service 内兜底，不在 schema 里加码

### 3. ThreadService

**文件：** `src/deerflow-harness/runtime/service.ts`；**单例入口：** `src/server/wiring.ts` → `getThreadService()`。装配 DeerFlowClient + Checkpointer + ThreadMetaStore + RunStore + RunRegistry + RunEventBus + AsyncLocalStorage Context（12 个操作：`createThread` / `listThreads` / `getThread` / `deleteThread` / `cancelRun` / `submitRun` / `subscribe` / `getCheckpoint` / `resume` / `beginShutdown` / `health` / `reconcileZombieRuns`）。

**关键不变量：**

- `submitRun` 立即返回 `run_id`，执行体 fire-and-forget；`try/catch/finally` 三重状态收敛：成功 `succeeded` + `idle`；失败 catch 中 publish ERROR 事件 → `failed` + `error`；兜底 finally 始终 publish END（channel 对已关闭状态 publish 是 no-op）
- `resume()` 经 `resumeStream()` 以 LangGraph `Command({ resume: decision })` 续跑人工中断（HTTP `operation: 'resume'` 触发）
- **run 可被取消**（进程内 `activeRuns` 注册表，按 `run_id` 挂在 service 闭包里），三条路径共用「abort signal + 可选等收尾」：
  - `cancelRun()`（用户点停止）：只 abort，不等收尾——交互要立刻有响应
  - `deleteThread()`：abort **并等收尾**（上限 3s）再删 meta / 沙箱容器 / checkpoint，否则 run 会在清理之后继续写 checkpoint，把刚删掉的数据写回来
  - `submitRun()` / `resume()` 抢占：同一 thread 只允许一个 run，新的先取消上一个未结束的（两个 run 并发写同一份 checkpoint 会交错，对话状态会坏）
  - 取消经 `signal` 生效：`DeerFlowClient.stream(..., signal)` → LangGraph `config.signal` → 一路下发到 LLM 调用。被取消的 run 记 `failed` + `cancelled: <原因>` 文案（`RunStatus` 是 DB CHECK 枚举，无 `cancelled` 值），**不能**记成 succeeded——`DeerFlowClient` 会把 abort 异常吞成正常 return，执行体必须显式判 `signal.aborted`（且此时不发 ERROR 帧，避免误报「运行出错」）
- **单例在 dev 下必须挂 `globalThis`**（`__threadService`）：Next.js 按路由分别编译 + HMR 重新求值模块，纯模块级变量会分裂成多份实例，跨路由的「取消 run」「按 run 订阅事件流」会**静默失效**。与 `lib/db` 的 pg pool 同一套做法，生产单次打包无此问题
- **心跳是 owner 存活信号**（间隔 `HEARTBEAT_INTERVAL_MS` = 15s，`runtime/liveness.ts` 单一出处）：除 publish HEARTBEAT 帧外还 `runRegistry.touch(run_id)` 续租 Redis owner 键（TTL 3 个心跳窗口）——键存活 = owner 存活，僵尸回收据此判死。touch 失败只告警一次不降级：瞬时失败下个心跳自愈，而按失败降级登记表会永久破坏跨进程取消
- **优雅停机 `beginShutdown(drainMs)`**（`DEERFLOW_GRACEFUL_DRAIN_MS`，默认 30s）：置 draining → `submitRun`/`resume` 抛 `SERVER_DRAINING`（503）→ 轮询 `activeRuns` 至空（≤drainMs，activeRuns 清空 ⟺ finally 已 publish END）→ 超时 abort 全部剩余 run（文案 `cancelled: server draining`）→ 再等 `RUN_CANCEL_GRACE_MS` 收尾 → 返回 `{cancelled, pending}`。幂等：重复调用复用同一 Promise。`health()` 暴露 `{distributed, draining}` 供 `/api/health` 与 LB 摘除——异步：先 `await` 登记表与事件总线的 `ready()`（幂等建连，失败走降级）再判 `isDistributed()`，避免「尚未建连」被误报为「已降级」；`/api/health` 在 middleware 放行（LB 探针无 cookie）
- **僵尸回收 `reconcileZombieRuns()`**（`runtime/zombie-reconciler.ts`）：`running` 且 `ownerOf` 为空且超一个心跳窗口的 run → `failed` + `cancelled: process died`。只有线程**最新** run 被回收才把 thread 置 `error`（抢占时旧 owner 崩溃不覆盖新 run 的 running）；单条失败不阻断整体对账；`isDistributed()` 为 false 时整体跳过（进程内登记表无跨进程死亡语义）。启动对账在 instrumentation 跑两轮（启动 + 60s，覆盖 owner 键尚未到期的窗口）。回收成功后经 `releaseRunSlot` 归还该 run 的全局并发名额（kill -9 走不到 finally 释放，不还则名额随僵尸永久流失）

**线程状态机：** `idle → running → idle（成功）/ error（失败）`

### 4. DeerFlowClient

**文件：** `src/deerflow-harness/client.ts`（进程级单例，注入到 ThreadService）。

- **Agent 实例缓存**：缓存键由 `[modelName, 运行期开关布尔组(memory/autoTitle/threadData/uploads/sandbox/summarization/guardrail/todo/mcp/subagents/vision), agentName, sortedSkills, mcpSignature, skillSignature, extraMiddlewareSignature]` JSON 签名组成（`buildConfigKey`）。**重要例外：`memoryEnabled=true` 时不缓存**（每轮 prompt 含最新 memory，必须每次重建）
- **运行期选项两级优先级**：`resolveRuntimeOptions(metadata)`——① metadata 显式开关（最高）② 构造时 `baseOptions`（wiring 默认 `agentName: 'lead'` + memory/autoTitle/threadData/uploads/sandbox/summarization/guardrail/todo 全开）。布尔覆盖必须严格 `typeof === 'boolean'` 才生效（`undefined` 不会被解释为 false）；`visionEnabled` 由 `modelConfig.supportsVision` 驱动，不开放 metadata 覆盖。解析结果是局部变量，不修改 `this.baseOptions`
- **stream()**：LangGraph `streamMode: ['messages', 'updates', 'custom']` 三模式同时订阅——messages：AI token 分片（`tool_call_chunks` 按 index 缓冲拼接 args，ToolMessage 到达才发 `TOOL_CALL_START` 完整调用信息）；updates：补抓 ToolMessage；custom：writer 推送的 payload（state*update / human_interrupt / task*\* 六种）
- `wiring.ts` 的 `createClientForModel`：请求携带 `modelConfig` 时按**完整 modelConfig 签名**（JSON.stringify）缓存 DeerFlowClient——支持单请求切模型，同时隔离不同用户的 apiKey。缓存键若是模型名，两个用户用同一模型会共用第一个用户的 Key；且 client 构造时固化 modelConfig，配置变化后旧实例永不刷新

### 5. 事件系统（双层协议）与 StreamBridge

**内部事件 `AgentEvent`**（`types/agent-event.ts`，20+ 枚举）→ **客户端白名单 `ClientAgentEvent`**（`runtime/sse/client-event.ts`，10 种，前端经 `src/runtime/protocol/client-event.ts` re-export 复用）：

- `start` — `{ sessionId?, run_id, thread_id, chatSession?, userMessageId?, assistantMessageId? }`（权威 START 由 chat-service 下发）
- `stream_chunk` — `{ text, reasoning? }`；`tool_call` — `{ toolCallId, toolName, arguments? }`；`tool_result` — `{ toolCallId, toolName, result, success }`
- `task_progress` — `{ taskId, status, ... }`：折叠 task\_\* 内部事件；status 含 started/running/tool_call/tool_result/completed/failed/cancelled/timed_out（subagent 内部工具调用透传前端）
- `todo_update` — `{ todos }`（latest-wins）；`human_interrupt` — `{ question, details }`
- `error` — `{ errorCode, errorMessage, recoverable }`；`end` — `{ titleUpdate? }`（autoTitle 落库后携带新标题）；`heartbeat` — `{}`

过滤边界在 `runtime/sse/to-client-event.ts`——白名单外的内部事件在此 drop，不泄露给前端。

**RunEventBus**（契约 `runtime/contracts.ts` + 双实现 `runtime/event-bus/`）——SSE 订阅的 wiring 面：`subscribe(threadId, runId, fromEventId?)` 返回带单调游标的 `StampedClientAgentEvent` 流（游标是断点续读凭证），`publish` 直通 + `release` 释放 run 级资源。进程内实现直包 StreamBridge（游标用 publish 时贴的递增序号，release drop channel 并留墓碑——已释放的 run 再订阅立即结束，不挂空 channel）；`RedisEventBus` 把事件镜像到 `deerflow:stream:{threadId}:{runId}`（XADD 内联 TRIM ~2000 与进程内 buffer 对齐、EXPIRE 24h 从最后一条事件起算）：订阅走独立连接 XREAD BLOCK 续读（阻塞读占住命令队列，**不能与发布共用连接**），中断退避后以同一游标重发——XREAD 幂等不丢不重；无 END 的悬挂流（owner 崩溃）由重连路由按 runs 终态补尾。REDIS_URL 未配置 / 连接失败 → 永久降级进程内实现（告警一次）。跨进程回放使 LB 粘性不再必要。

**StreamBridge**（`runtime/stream-bridge/stream-bridge.ts`）：`channels: Map<"threadId:runId", ThreadChannel>`。**ThreadChannel 是每 run 一个的 typed `EventEmitter<ChannelEventMap>`**——10 个 `ClientAgentEventType` 就是事件名（emit/on 传整个事件对象），另挂 `CLOSED_EVENT` Symbol 事件作内部唤醒信号：close() 时发出，把「唤醒」从「数据」剥离，不再合成 system END 帧（chat-service 里按 `agentId==='system'` 过滤的跨文件耦合随之删除）。`publish()` 是唯一写入口（类内 `emitEvent` 类型桥规避「联合事件名+联合值」的 TS 推断失败）；构造函数常驻 no-op `'error'` 监听——`error` 是白名单事件名却撞 EventEmitter 内建语义（无监听者 emit 会抛）。`subscribe()` 仍是 SSE 稳定契约：手写四步 next()（回放快照 → 消费 pending → 检查关闭 → 挂起等下一个事件），buffer 快照与对全部事件名的监听注册在**同一同步块**内完成——事件要么在快照里（回放）要么进 pending（实时），不丢不重；跨类型全局序由单一 pending 队列保持。**不用 `events.on()` 重写 subscribe**：合并多事件名会丢跨类型时序，且 'error' 的终止语义与「ERROR 是流中间事件、END 才终止」相反。终止：END → `close()`（emit CLOSED_EVENT + removeAllListeners，后续 publish no-op）；`recoverable=false` 的 ERROR 不立即 close，由 END 兜底。

### 6. Agent 工厂与中间件管线

**文件：** `src/deerflow-harness/agents/factory.ts`

- `createBaseAgent(opts)`：`middlewares` 与 `features` / `extraMiddlewares` 互斥；extraTools 与 tools 按工具 `name` 去重合并；`withCallLogAll()` 给所有中间件包调用日志（`MW_TRACE` 控制）；用 `ThreadStateAnnotation` 作 state schema
- **`assembleFromFeatures` 按 `ORDERED_MIDDLEWARES` 位序装配**（「服务级默认」指 wiring.ts 的 sharedClientOptions）：

- — `QwenToolCallRecovery`（provider='qwen' 或 feature 显式）
- 0 `ThreadData`（默认开；beforeAgent 从 `file_metadata` 装载 uploadedFiles）
- 1 `Uploads`（默认开；上传文件以 SystemMessage 注入 prompt。**优先读 state.uploadedFiles，为空时自行按 thread_id 查库**——LangChain v1 中间件输入限于自身私有 state + messages，上游写入的 state 在下游读不到，只依赖 state 会导致注入永不发生）
- 2 `Sandbox`（sandbox=true；beforeAgent `retain`(+1) / afterAgent `markIdle`(-1) 维护容器引用计数）
- 3 `ToolCallIntegrity`（始终启用：悬空调用 + 未知调用两条子规则）
- 4 `Guardrail`（默认开仅告警；`DEERFLOW_GUARDRAIL_BLOCK` 可选拦截）
- 5 `ToolErrorHandling`（始终启用）
- 6 `Summarization`（须传 `createSummarizationMiddleware(model)` 实例，不允许 true；默认开；历史触达阈值摘要）
- 7 `Todo`（默认开；`write_todos` + `todo_update` 下发前端）
- 8 `Title`（默认开；afterAgent 用固定小模型异步生成标题，落 chat_session/threads_meta）
- 9 `Memory`（默认开）
- 10 `Vision`（由 `modelConfig.supportsVision` 驱动；历史 `image_url` blocks 压成文本占位 + 注入 `view_image` 工具）
- 11 `SubagentLimit`（始终启用：lead 永远具备 task 能力，需并发/总量上限兜底）
- 12 `LoopDetection`（始终启用）

`taskTool` 始终注入 `extraTools`；`features.sandbox` 启用时 7 个沙箱文件/执行工具（`SANDBOX_TOOLS`）注入 lead 工具集（subagent 经工具注册表继承）。`RuntimeFeatures` 各键 `false | true | M`（M=自定义中间件实例；summarization 不允许 true）。`@Next`/`@Prev` 装饰器为自定义中间件指定插入锚点（类或实例），无锚点或锚点不在链上时追加链尾（不丢中间件）。

### 7. Subagent 系统

**文件：** `src/deerflow-harness/subagents/`

- **内置 general-purpose**（对齐 deer-flow 2.0）：`tools: undefined` 继承 lead 工具集 + `disabledTools: ['task']` 防递归 + `model: 'inherit'` 复用 lead modelConfig（经 ALS `currentModelConfig` 透传，`configurable.currentModelConfig` 兜底）。`SUBAGENT_FEATURES` 硬关 subagents——子 agent 的 LLM 工具列表里没有 task，从根上杜绝递归委派（不依赖 system prompt 自律）
- **SubagentExecutor**：无全局状态；每次 `execute(prompt, parentSignal)` 独立构造 Agent 实例，不复用缓存；parentSignal + 内部 timeout 组合 abort 同一个 internalController；终态事件（completed/failed/timed_out/cancelled）至多 yield 一次；资源在 finally 清理。产出经 `extractSubagentReport` 尝试解析 final-report JSON 块
- **thread_id 透传，但子图状态不落 checkpoint**（三条路径实测证伪，结论见 `buildSubagentStreamConfig` 注释，行为由 `subagent-checkpoint-quirks.integration.test.ts` 锁定）：① 传 `checkpoint_ns` 无效——LangGraph 对非嵌套顶层图强制把 ns 置空；② 合成 thread id（`{parent}#sub:{taskId}`）会让沙箱目录解析错位（沙箱工具优先读 `configurable.thread_id` 推导 thread 目录）；③ 共用父 thread_id 落盘会污染父状态（父图 `getState()` 返回子 agent 的 messages，resume / 回放错乱）。子 agent 的唯一持久化产物是它在父图中留下的 `task` 工具结果（ToolMessage）
- **父历史只读注入**（`subagents/parent-history.ts`）：wiring 经 `setParentHistoryProvider` 注册 checkpointer `getTuple` 读取；executor 构造输入前读一次，剪枝为纯文本上下文块（4k 字符预算、去 base64 / uploads 块、跳过纯 tool_call 消息）作 SystemMessage 前置；读取失败静默回落不阻断 task。**只读不写**，与「子图不落 checkpoint」决定正交

### 8. 记忆系统（Memory）

**文件：** `src/deerflow-harness/agents/memory/`

- **结构 `MemoryData`**：`user.workContext/personalContext/topOfMind` + `history.recentMonths/earlierContext/longTermBackground`（各带 summary + updatedAt）+ `facts[]`（id/category/confidence/source/embedding）
- **存储**：`FileMemoryStorage` 落 `{DEERFLOW_DATA_DIR|~/.deer-flow}/users/{userId}/memory.json`（lead 主链路固定 per-user 作用域，跨 agent 共享该用户记忆）
- **LLM 驱动更新（MemoryUpdater）**：加载 → 拼 prompt（注入当前 memory + 对话 + 校正/强化提示）→ LLM invoke（**关键：显式 `callbacks: []`**，切断与外层 SSE handler 的回调链，防止向已关闭的 ReadableStream 写入触发 ERR_INVALID_STATE）→ JSON 解析（含 tryRecoverJson 修复 Qwen maxTokens 触顶的尾部截断）→ applyUpdates（confidence 过滤 + casefold 去重 + maxFacts 截断）→ stripUploadMentions 清洗文件引用 → 落盘
- **注入模式**：`inject`（默认，全量：所有 section + facts 按 confidence 降序，2000 token 预算）/ `retrieve`（按本轮输入检索 top-K facts + 最相关一段 history，800 token 预算）。由 `configuration.memoryMode` 切换
- **混合检索**（`retrieval.ts` 纯函数；词面 + 语义混合打分）：词面分量 = 重叠率(|text∩query|/|query|) × (0.5 + 0.5×confidence)；语义分量 = 余弦 × `embeddingHybridWeight`（默认 0.7），需过门槛才参与；facts 与 sections 同一套打分核心。query：词面用近 3 轮用户输入拼接（省略式提问「它呢？」命中上轮实体），语义只用当前轮（拼串稀释向量语义）。全部落空 → 不注入（避免无关记忆干扰）；workContext/personalContext 视为身份信息恒保留
- **向量基础设施**（`embeddings.ts`）：智谱 embedding-3（OpenAI 兼容 `/embeddings`，dimensions 256..2048 默认 1024），工厂由 wiring 经 `setMemoryEmbeddingsFactory` 注入；未注册 / 无 Key / API 失败一律静默降级词面。**必须显式传 `encodingFormat: 'float'`**：SDK 缺省时按 base64 解码响应，而智谱忽略该参数仍返回 float——1024 维被当字节流重解释成 256 个无意义数，余弦成 NaN，语义检索悄悄退回词面且无报错
- **阈值 0.6 系实测标定**：embedding-3 中文短文本无关基线 0.44~0.55，真相关 0.64~0.69，阈值须落在两者之间（标定依据见 retrieval.ts 注释）；换 embedding 模型 / 语言后需重标定。**记忆与提问须同语言**：跨语言余弦 0.33~0.49 全低于阈值，故 MEMORY_UPDATE_PROMPT 要求用用户对话的语言写 summary 与 facts
- 无向量库 / 无 ANN：向量随 memory.json 落盘，检索即内存线性扫描，受 maxFacts（100）约束；观察入口 `GET /api/memory/retrieve?q=`（与真实注入同一段代码）；旧数据回填 `backfillMemoryEmbeddings`（补缺失 / 维度不匹配的 facts 与 sections，save 前 reload 合并防互踩）

### 8.5 MCP 与 Skill 扩展（extensions）

- **统一配置**：`extensions_config.json`（`DEERFLOW_EXTENSIONS_CONFIG_PATH` 可覆盖，默认 `{cwd}/extensions_config.json`），含 `mcpServers` + `skills` 两个 map，模板见 `extensions_config.example.json`。`FileExtensionsConfigStore` 复用 memory 的 FileStorage 范式：mtime 缓存 + 原子写（tmp→rename）+ schema 校验失败回退空配置。文件与 `skills/custom` 为运行期状态，已 gitignore
- **Skill**（Prompt 注入式，无沙箱）：扫描 `skills/public|custom/<name>/SKILL.md`，自写最小 frontmatter 解析器提取 name/description，正文用于 prompt 注入。`loadEnabledSkills()` 合并配置中的 enabled 状态；**默认禁用（opt-in）**——启用即注入系统提示，有 token 成本。注入点：`buildLeadAgentSystemPrompt()`（顺序：BASE_SYSTEM_PROMPT → skills → memory），skill 加载失败降级为无 skill
- **MCP**（端到端，依赖 `@langchain/mcp-adapters`）：按启用 server 构建 `MultiServerMCPClient` 加载工具；`env`/`headers` 中 `$VAR` 用 process.env 解析（未命中替换为空串）。**关键不变量：`throwOnLoadError: false`**（单 server 失败跳过，不阻断对话）；`prefixToolNameWithServerName: true`（防与内置工具重名）；按「启用 server 配置签名」缓存 client，签名变化才重连。接入：`DeerFlowClient.ensureAgent()` 在 stream 首帧前 await `loadMcpTools()` 并入工具集；`buildConfigKey()` 纳入 MCP/skill 启用签名，配置变更后 agent 自动重建。stdio server 需 spawn 子进程，相关 API 路由显式 `runtime='nodejs'`
- 管理 API：`/api/mcp` 族（写后 `resetMcpClient()` 失效缓存）、`/api/skills` 族 + 设置弹窗「技能」「工具」页

### 8.6 安全沙箱与多对话并行编排（sandbox）

**文件：** `src/deerflow-harness/sandbox/`（完整设计见 `docs/sandbox-implementation.md` §10 为并行编排）

沙箱为 Agent 提供受限的文件读写/搜索/list/bash 执行环境（路径安全校验 + 文件操作锁 + 异常隔离），后端可插拔：

- **后端工厂**（provider-factory，进程级单例，`setSandboxProvider()` 供测试注入）：`local`（默认）宿主文件系统直连，bash 受 `DEERFLOW_ALLOW_HOST_BASH` 门控；`docker` 每 thread 一个长驻加固容器（内核级隔离）；`remote` 每 thread 一条 SSH 长连接。docker/remote 是隔离边界，**不受 host-bash 门控**。依赖方向 factory → local/docker/remote、docker → local（仅重写 executeCommand 走 docker exec），单向无循环
- **docker 后端**：`sleep infinity` 加固容器（`--cap-drop ALL` + `no-new-privileges` + memory/cpus/pids 限额 + 非 root 降权）；卷挂 `{threadDir}/user-data → /mnt/user-data`（不暴露宿主真实路径，内部反向映射）；引用计数 + 空闲回收 + LRU + 容器消失时 reprovision 重建。`docker-cli.ts` 用 `execFile` + 参数数组（**禁 shell 拼接防注入**）
- **remote 后端**：**缺 host 或私钥时构造即抛错**（避免静默降级宿主直连）；per-thread SSH 连接池（ssh2，幂等复用 + 引用计数 + 空闲回收 + keepalive + 进程内信号量）；全部 IO 经 SSH 往返——readFile base64 往返保编码、writeFile 走 stdin 超 `DEERFLOW_REMOTE_MAX_WRITE_BYTES` 拒绝、listDir/glob/grep 远端执行并把远程路径还原为 `/mnt/user-data`。**并发上限按进程独立计**，多进程部署实际连接数 = 上限 × 进程数
- **双层背压**：run 级 `RunConcurrencyGate`（`runtime/run-concurrency-gate.ts`，进程 FIFO 信号量 + 跨进程 `runs:count` 占位；接在 service 执行体消费 stream 之前 acquire，超限先 publish `task_progress{status:'queued'}`——对话仍可先思考，finally 释放）+ 容器级 `DEERFLOW_DOCKER_MAX_LIVE_CONTAINERS`（活跃容器上限，配合空闲回收与启动 reconcile 清孤儿）
- **run 名额凭据**：跨进程占位落 per-run 槽键（`deerflow:sandbox:run:slot:{runId}`，`tryReserveRun(runId, maxRuns)` 原子 INCR 计数 + SET 槽键）；释放 = DEL 槽键成功才 DECR 计数（Lua 原子）——正常 finally 与僵尸回收共用这条路径，槽键一次性 DEL 保证计数恰好扣一次（两方并发也不会多扣），kill -9 丢失的名额由僵尸回收归还
- **引用计数不变量**：refCount = 正在使用容器的 run/agent 层数，由 sandbox-middleware 的 beforeAgent retain(+1) / afterAgent markIdle(-1) 严格成对；`acquire` 幂等命中只 touch 不 incRef（避免 subagent/工具惰性 acquire 泄漏）；`deleteThread` 联动 `releaseByThreadId` 销毁容器
- **跨进程协调**（docker-coordinator）：Redis 原子计数（Lua RESERVE/RELEASE）、thread→container 登记 Hash、`SET NX PX` 分布式锁；**Redis 不可用自动降级进程内 Map**
- 监控：`sandbox/sandbox-monitor.ts` + `GET /api/sandbox/stats`（`DEERFLOW_SANDBOX_STATS_TOKEN` 门控，`runtime='nodejs'`）

### 8.7 视觉多模态（vision）

**文件：** `src/deerflow-harness/vision/`

- 能力开关由**模型能力**驱动：preset 的 `supportsVision` → `resolveRuntimeOptions` 的 visionEnabled → features.vision（进 agent 缓存键）。不开放 metadata 覆盖
- **链路**：上传时 OCR（见下）→ 聊天时 `resolveFilesByIds` 反查组装 `ThreadImageRef[]` → `submitRun({ images })` → `buildHumanMessageContent`（supportsVision 且带图时构造 content blocks：文本块 + `[附图: 文件名]` 标签 + image_url data URL）
  - **传输用 base64 data URL**：内网部署下 MinIO presigned URL 对模型服务商不可达，base64 是唯一可靠通道
  - **线上格式必须是 `image_url`**：@langchain/openai 只转换带 `source_type` 的 data block；换成语义更「标准」的 `ContentBlock.Multimodal.Image` 会被原样透传并 400
- **历史压缩先于摘要**：VisionMiddleware 用 beforeAgent（摘要中间件用 beforeModel），LangGraph 结构保证压缩先于摘要——否则 base64 会被 JSON.stringify 进摘要 prompt。历史 `image_url` blocks 全部换 `[图片已查看，可用 view_image 重新查看]`（克隆时保留 id——add_messages 按 id merge；无 id 的跳过，否则 append 语义会重复）
- **`view_image` 工具**：模型按文件名重新查看图片（句柄来自 `[附图: xxx]` 文本块）。返回多模态 ToolMessage，**必须自带 `runtime.toolCallId`**（ToolNode 对 ToolMessage 实例原样采用，不会补）
- **SSE 安全**：messages 模式显式跳过 ToolMessage；updates 模式 tool 分支经 `extractContentTextBlocks` 剥离 image blocks——base64 不会进入 SSE 事件与前端 parts-reducer
- **图片 OCR（上传解析）**：`lib/files/file-parser.ts` 对 image/\* 调 `ocrImageFromZhipu`——主路径智谱**原生** `POST {base}/layout_parsing`（**file 必须用 data URI**：实测裸 base64 被拒 code 1214），失败降级视觉模型读图转 markdown，再失败返回占位文本（layout_parsing 会拒绝某些合法图片）。**永不抛错**：`/api/files/upload` 把解析异常记为 `status='failed'`，前端有「全部文件 parsedStatus 为 success 才可发送」的硬门禁——抛错会让用户传图后根本发不出消息。图片分支**绕过**文本提取末尾的空白折叠，否则 markdown 表格/标题层级会被压平

### 9. 持久化（PG schema）

- **threads**（PgThreadMetaStore，`persistence/thread-meta/postgres-store.ts`）：id / thread_id / user_id / assistant_id / display_name / status（'idle'|'running'|'error'|'interrupted'）/ metadata JSONB / 时间戳；metadata 用 `@>` 操作符过滤；全部操作带 user_id 访问控制
- **runs**（PgRunStore，`persistence/runs/postgres-store.ts`）：id / thread_id / assistant_id / user_id / input / status（'running'|'succeeded'|'failed'）/ error / metadata JSONB / 时间戳
- **Checkpointer**：`@langchain/langgraph-checkpoint-postgres`，工厂 `makeCheckpointer()`（`runtime/checkpointer/factory.ts`），代理 lib/db 单例连接池

### 10. 前端状态管理（Zustand）

**chatSessionStore**（`src/store/chat-session-store.ts`）：支持「切换对话后正在跑的对话不中断、侧栏按运行态显示」，采用**分桶为真相源 + 当前视图投影**：

- `sessionRuntimes: Record<sessionId, { messages, status: 'idle'|'running'|'done'|'error', abortController, lastActiveAt }>`——每个对话一个独立运行桶（真并行的真相源）
- 按 sessionId 的 action：setSessionMessages / setSessionStatus / setSessionAbortController / getSessionRuntime / `migrateSessionRuntime`（临时 id → 真实 id）/ abortSession
- `currentMessages` / `isChating` 降级为「currentSessionId 桶的投影」，切对话时从桶恢复投影（含正在跑的消息与运行态），避免全局单例被切走的对话覆盖
- 事件泵（`src/runtime/context/agent-event-context.tsx` 的 `AgentEventProvider`）每 session 一个 pump，emit 前给事件盖 `sessionId`+`streamId` 分拣戳；store 写入者 `SessionStreamSink`（`src/utils/chat/agent-event-sink.ts`）作为 EventBus 的一等通配订阅者按初始 sid 路由写桶——START 用 `migrateSessionRuntime` 衔接新建对话的临时 id 与后端真实 id；侧栏 `SessionStatusIndicator` 订阅 `sessionRuntimes[id]?.status` 显示运行态

**停止按钮的三条不变量**（改这块前先看，坑都踩过）：

1. 提交处理必须把 `isChating` 分支放在 `if (disabled) return` **之前**——chat-window 传的是 `disabled={isChating || guardDisabled}`，聊天中 disabled 恒 true，顺序反了就是死按钮；按钮自身 `disabled={disabled && !isChating}`（聊天中必须可点）
2. 停止要做两件事，且**先发取消请求、再 abort**：`cancelRunOnServer(sessionId)`（`POST /api/conversations/cancel_run`）+ `abortCurrentChat()`（本地 fetch + 收起运行态）。只 abort 本地的话服务端 run 会继续生成并把**完整回答**落库；store 的 abortCurrentChat 不能因为拿不到 abortController 而整个 no-op。**泵的 AbortController 由 `startSessionSink` 经 `setSessionAbortController` 注册进 sessionRuntimes 桶**——停止按钮 abort 的正是它，改泵接线时不能丢这步
3. 取消后消息要收尾：新增 `cancelled` part（文案「用户已取消」/「已被新消息取代」）——前端在 abort 分支追加（否则模型还没吐 token 时 parts 为空，气泡永远转圈）；服务端在落库前用 `waitRunError(run_id)` 等 run 落到终态、判定取消后把同一条标记补进 parts 末尾（**落库 parts 才是刷新后的真相源**，前端加而服务端不加，刷新就丢）。服务端那条必须等：客户端先断流再（几乎同时）发 cancel，断流那一刻 run 还在 running。气泡转圈条件收紧为「parts 为空且 isChating 且是最后一条 assistant」

**前端 SSE 处理链**：`useAgentEvent().run()` → `AgentEventProvider` 泵（`fetch() POST /api/v3/chat` → `create-agent-event-stream.ts` → `sse-frame-parser.ts` 逐行解析 data: JSON 帧 → `event-bus.ts` 广播；`RoutedClientAgentEvent = ClientAgentEvent & { sessionId, streamId }` 是前端本地分拣戳，不进线协议）→ `agent-event-sink.ts`（SessionStreamSink 通配订阅者：占位消息 / START id 迁移 / rAF 合帧 commit / 错误兜底）→ zustand 桶；组件侧 `useAgentEventListener()` 就近订阅 EventBus。`event-bus.ts` 基于官方 `events` 包（显式依赖 ^3.3.0，Next 14 客户端不能用 `node:` 前缀），补三样官方没有的语义：通配 `'*'` 订阅、handler 异常隔离（try/catch 包装）、`on` 返回 unsubscribe。

### 11. 关键设计模式

- **进程级单例**：wiring.ts `getThreadService()` 懒初始化（DeerFlowClient + Checkpointer + Stores + createClientForModel），dev 下挂 globalThis（见 §3）。App 侧 service 用 `createXService(deps?)` 工厂 + 模块级懒单例 `getXService()`——无跨请求可变状态，模块级单例即可
- **app → harness 注入点**（依赖方向单向，wiring 统一注入）：`setMemoryModelFactory`（记忆更新 LLM）、`setTitleModelFactory`（标题/提示词增强）、`setMemoryEmbeddingsFactory`（智谱 embedding-3）、`setThreadImageFetcher`（MinIO 图片字节读取）、`setParentHistoryProvider`（子 agent 父 checkpoint 读取）
- **AsyncLocalStorage 上下文传播**（`runtime/context.ts`）：`runWithContext()` 在整个 Agent 调用栈提供 threadId / runId / userId / agent_name / currentModelConfig；SubagentExecutor 经 `getContext()?.thread_id` 读父线程 ID、`currentModelConfig` 透传 modelConfig
- **幂等线程创建**：前端生成 `sessionId`（UUID）作请求体字段调 `POST /api/v3/chat`，`createThread()` 先查再写，外部指定 ID 天然支持请求重试
- **LLM 用量记账**（`runtime/usage-accounting.ts` + `pricing.ts`）：模型工厂（models/index.ts，lead 与 subagent 的唯一模型入口）挂 callback handler，把每次调用的 usage 累加进 **ALS 作用域**累加器——一处覆盖 lead + subagent + 中间件的全部 LLM 调用，不改 SSE 协议不动前端。两条不变量：① sink 必须在调用时解析（agent 实例跨 run 缓存，绑死会混用量）② 产品路径默认没有 sink（handler 直接返回，行为与接线前一致）

### 12. 调试技巧

```bash
MW_TRACE=1 pnpm dev          # 中间件调用日志（[mw] 前缀）
DEERFLOW_DEBUG_AI=1 pnpm dev # 完整 AI 输出（text + reasoning）
MEMORY_DEBUG=1 pnpm dev      # 记忆更新日志（LLM 调用 / JSON 修复 / 增量更新落盘）
```

- 启动时控制台打印 `[agent] tools bound to LLM (N): ...`
- 手动测 SSE：先登录存 cookie（`curl -c cookies.txt`），请求带 `Accept: text/event-stream --no-buffer`；切模型用 `sessionId` + `configuration.model.value`（MODEL_PRESETS 预设键，如 `deepseek-v4-pro`）
- 查库：`psql $DATABASE_URL -c "SELECT id, status, display_name, created_at FROM threads ORDER BY created_at DESC LIMIT 20;"`
- 记忆文件：`~/.deer-flow/`（或 `$DEERFLOW_DATA_DIR`）下 `users/{userId}/memory.json`；记忆检索观察 `GET /api/memory/retrieve?q=`

### 13. 关键文件索引

- `src/server/wiring.ts`——ThreadService 进程单例工厂（globalThis + ensure\* 注入点）
- `src/server/http/`（api-handler / errors / auth / logger / rate-limit）——统一请求管线 / 错误映射（toHttpError）/ 会话 cookie / HTTP 访问日志 / 限流占位
- `src/server/validation/schemas.ts`——全部路由 body/query 的 zod schema（v4，`error.issues`）
- `src/server/daos/`（chat-session / chat-message / file-metadata / file-content）——app 侧四张表单表 SQL（SqlExecutor + withTransaction）
- `src/server/services/`——领域编排（chat / conversation / file / memory / model-key / extension / prompt-enhance / sandbox / model-config）
- `src/server/services/model-config-service.ts`——主聊天链路模型解析：用户选定预设 + 该 provider 加密 Key → ModelConfig
- `src/config/models.ts`——MODEL_PRESETS 预设（默认 deepseek-v4-flash）与 ModelConfig 构建（harness `models/` 只含 createChatModel 工厂与 provider 推断）
- `src/lib/crypto/model-key-crypto.ts`——用户模型 Key 加密存取（`MODEL_KEY_ENC_SECRET`）
- `src/app/api/v3/chat/route.ts`——主聊天 API 薄路由（编排在 chat-service，sessionId 走 body）
- `src/deerflow-harness/client.ts`——DeerFlowClient：Agent 缓存 + LangGraph 流式调用
- `src/deerflow-harness/runtime/service.ts`——ThreadService（fire-and-forget + 取消三路径）
- `src/deerflow-harness/runtime/run-concurrency-gate.ts`——run 级并发闸门（FIFO 信号量 + 跨进程占位）
- `src/deerflow-harness/runtime/usage-accounting.ts`——LLM 用量记账（模型工厂挂接，ALS 累加器）
- `src/deerflow-harness/agents/factory.ts` / `features.ts`——createBaseAgent + assembleFromFeatures / RuntimeFeatures + Next/Prev 装饰器
- `src/deerflow-harness/runtime/stream-bridge/stream-bridge.ts`——StreamBridge + ThreadChannel（每 run 一个 typed EventEmitter + 缓冲回放）
- `src/deerflow-harness/runtime/event-bus/`（in-memory.ts / redis.ts）——RunEventBus 双实现（进程内游标 / Redis Stream 镜像 + XREAD 续读）
- `src/deerflow-harness/runtime/liveness.ts`——心跳间隔与 owner 死亡窗口常量（单一出处）
- `src/deerflow-harness/runtime/zombie-reconciler.ts`——僵尸 run 启动对账回收
- `src/instrumentation.ts`——优雅停机信号处理 + 记忆队列 flush + 僵尸对账两轮调度
- `src/app/api/health/route.ts`——健康检查（`distributed` / `draining`，排水期 503）
- `src/deerflow-harness/runtime/sse/client-event.ts` / `to-client-event.ts`——ClientAgentEvent 白名单协议 / 内→外过滤边界
- `src/deerflow-harness/types/agent-event.ts`——AgentEvent 内部事件枚举
- `src/deerflow-harness/subagents/executor.ts` / `parent-history.ts`——SubagentExecutor（超时+取消）/ 父历史只读注入
- `src/deerflow-harness/agents/memory/updater.ts` / `embeddings.ts` / `retrieval.ts`——MemoryUpdater / 向量基础设施 / 混合检索
- `src/deerflow-harness/vision/image-fetcher.ts` / `vision-middleware.ts`——图片字节注入 + 多模态 content 构造 / 历史图片压缩
- `src/deerflow-harness/tools/builtins/`——内置工具（task / search_web / clarification / view_image）
- `src/lib/files/file-parser.ts`——上传文件解析（PDF/DOCX/文本 + 图片 OCR）
- `src/deerflow-harness/extensions/config-store.ts` / `skills/loader.ts` / `mcp/client.ts`——扩展配置存储 / skill 加载器 / MCP 客户端
- `src/deerflow-harness/sandbox/provider-factory.ts` + `docker/` + `remote/`——沙箱后端工厂 + Docker 后端 + Remote 后端
- `src/store/chat-session-store.ts`——前端聊天会话状态（sessionRuntimes 分桶并行）
- `src/runtime/context/agent-event-context.tsx`——AgentEventProvider（每 session 泵 + sink 挂载）
- `src/utils/chat/agent-event-sink.ts` / `chat-request-body.ts`——SessionStreamSink 注册表（事件→store）/ `/api/v3/chat` 请求体纯组装
- `.github/workflows/deploy.yml` / `scripts/deploy-remote.sh`——CI/CD 流水线 / 服务器端部署
- `docs/deploy-runbook.md` / `docs/cicd-notes.md` / `docs/sandbox-implementation.md`——部署操作手册 / 技术沉淀（踩坑实录）/ 沙箱完整设计

### 14. 已知限制

1. 跨进程全局 run 上限与进程内同源：Redis `runs:count` 以 `DEERFLOW_MAX_CONCURRENT_RUNS` 为全局闸门，多进程总并发 ≈ 该值（不是 × 实例数），扩容需同步调大；僵尸回收死亡窗口为 3 个心跳（45s），kill -9 后线程在该窗口内仍显示 running（下轮对账修正），其占用的全局名额同轮归还（槽键释放）
2. ThreadChannel buffer 默认上限 2000 条（`STREAM_BRIDGE_BUFFER_MAX` 可调），超限丢弃最旧非关键帧（`start`/`error`/`end`/`human_interrupt` 关键帧永不丢弃）
3. 单次请求只能使用一个模型（不支持混合 Qwen + OpenAI）
4. 单元测试覆盖建设中（vitest 已接入，覆盖中间件装配、防递归、guardrail 规则、记忆检索、checkpoint 行为约束、remote 沙箱、父历史剪枝等核心纯逻辑）
5. 记忆检索无向量库 / 无 ANN：向量随 memory.json 落盘，检索即内存线性扫描，受 maxFacts（100）约束；facts 规模显著增长后需另接向量存储
6. remote 沙箱并发上限按进程独立计（不做跨进程协调），多进程部署实际连接数 = 上限 × 进程数
7. `view_image` 仅支持本会话上传的图片（按文件名）；沙箱产物图片（如 matplotlib 输出）未支持——Sandbox 基类只有文本 readFile，要支持需为 local/docker/remote 三个后端各加二进制读取
8. 智谱 `glm-5.3-flash` 是**推理模型**：reasoning 计入 completion_tokens，`max_tokens` 过小（实测 32）会让 content 为空。副链路（标题生成 maxTokens 默认 64）若被指定为该模型需注意；主聊天链路不设 maxTokens，走 provider 默认值，不受影响
9. 上传的文件对象在「删除对话」时才清理；未发送就放弃的上传（未关联任何消息）会在 MinIO 留下未引用对象
