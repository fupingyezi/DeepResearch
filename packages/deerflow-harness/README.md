# @deerflow/harness

deerflow agent SDK——多智能体对话运行时（LangChain/LangGraph 1.x）：

- **单一 lead-agent 形态**：lead 永远具备 subagent 能力（`task` 工具 + general-purpose subagent），自主判断「简单直接答 / 并行分解」
- 中间件管线（`ORDERED_MIDDLEWARES` 位序装配：uploads / sandbox / guardrail / summarization / todo / title / memory / vision / loop-detection …）
- 事件系统：内部 `AgentEvent` → 客户端白名单 `ClientAgentEvent`（10 种）→ `createSseStream`（SSE 出口）；线程生命周期、事件总线、流缓冲（StreamBridge）属产品层，在宿主侧 `src/backend/runtime/`（见下）
- 记忆引擎：LLM 驱动更新 + 双路召回（pgvector 向量 + BM25 词面）→ RRF → rerank 精排；内置 InMemoryMemoryStorage 开箱即用，持久化后端由宿主实现 `MemoryStorage` 契约注入
- 沙箱（local / docker / remote 三后端）、视觉多模态、MCP / skill 扩展、LLM 用量记账

## 定位与边界

- **零 `@/` 依赖**：包内不含任何宿主应用代码（eslint `no-restricted-imports` 固化），可在任意 Node 项目复用
- **无 build 产物**：本仓库内经 tsconfig paths（`@deerflow-harness` / `@deerflow-harness/*`）直编译包源码；独立发布时补 tsup 构建与 main/exports 即可（TODO，见本仓库 plan）
- **SDK 只含执行层 + 契约 + 内存默认实现**：线程/进程生命周期、事件总线与流缓冲、SQL 仓库、部署策略等产品语义层不属 SDK（本仓库在 `src/backend/runtime/` / `repositories/` / `harness-adapters/`），LangGraph `InMemorySaver` 同款模式——存储适配器由宿主实现契约注入
- 上下文装配、沙箱装配、记忆检索都是**封装 API**：DB、模型配置、图片字节、Tavily、Redis 全部由宿主经注入面提供，包内不读宿主环境变量、不直连宿主存储

## 注入面（宿主装配清单）

全部 setter 走 globalThis 单例（Next dev HMR 分包安全），由宿主在组合根（本仓库为 `src/backend/wiring.ts`）注册一次：

| 接口                                                                                 | 宿主职责                                                                 | 消费方 / 未注册行为                                                                                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `SqlExecutor`（`types/sql-executor`）                                                | 构造注入 `query` + `transaction` 最小 SQL 能力（契约类型，SDK 内无实现） | 宿主侧契约实现（`src/backend/harness-adapters/pg-memory-storage.ts`）；构造即需实例                          |
| `makeCheckpointer({ kind: 'postgres', postgres: { pool } })`                         | PG checkpoint saver（含 `saver.setup()`，池归宿主管理）                  | ThreadService checkpointer                                                                                   |
| `setTitleStoreProvider`                                                              | 标题读/写落库（`loadCurrentTitle` / `persistTitle`）                     | title-middleware；未注册 warn 一次并跳过落库                                                                 |
| `setUploadedFilesProvider`                                                           | 按 thread 装载上传文件内容                                               | thread-data-middleware / UploadsMiddleware；未注册 warn 一次，文件不注入                                     |
| `setRedisClientFactory`                                                              | 按需构造 Redis 客户端（socket 选项由消费者自定）                         | SDK 内 docker-coordinator + 宿主侧协调组件（event-bus / run-registry / dist-lock）；未注册全部降级进程内实现 |
| `setTavilyApiKey`                                                                    | 联网搜索 Key                                                             | `search_web` 工具                                                                                            |
| `setMemoryModelFactory` / `setTitleModelFactory`                                     | 记忆更新 / 标题生成 LLM                                                  | 副链路；未注册静默降级                                                                                       |
| `setMemoryEmbeddingsFactory` / `setMemoryRerankerFactory`                            | 向量化 / 精排 API                                                        | 记忆检索；未注册回落词面 / 保持 RRF 序                                                                       |
| `setThreadImageFetcher`                                                              | 图片字节读取（MinIO 等）                                                 | vision 多模态注入                                                                                            |
| `setParentHistoryProvider`                                                           | 子 agent 父历史只读读取（checkpoint）                                    | subagent 上下文注入                                                                                          |
| `setMemoryStorage`                                                                   | 记忆存储后端                                                             | Noop 为默认：记忆功能关闭、聊天不阻断；SDK 内置 InMemoryMemoryStorage 供无 DB 场景 / 测试夹具选用            |
| `setSandboxProvider`                                                                 | 沙箱后端（测试注入用）                                                   | 默认 local                                                                                                   |
| `ClientOptions.middlewareConfigProvider`                                             | 每次 agent 构建前返回装配快照（开关 + 中间件选项 + 配置签名）            | `ensureAgent`：enabled 门控、`create*` 选项、签名折入缓存键；未注册 = baseOptions 直用                       |
| `ClientOptions` 的 `guardrail` / `subagentLimit` / `loopDetection` / `summarization` | 四个中间件的构造选项（服务级默认）                                       | `assembleFromFeatures` 的 `create*`；不传 = 构造器常量默认                                                   |

本仓库的 app 侧实现：`src/backend/wiring.ts`（注册 + 每 run 独立 DeerFlowClient 工厂）+ `src/backend/harness-adapters/`（title-store / uploaded-files / pg-memory-storage 的 SQL 实现）。ThreadService、RunEventBus / StreamBridge、协调锁、并发闸门、僵尸回收等产品层组件在 `src/backend/runtime/`，不经本包。

## 消费方式（本仓库内）

```ts
import {
  DeerFlowClient,
  InMemoryMemoryStorage,
  makeCheckpointer,
  type SqlExecutor,
} from '@deerflow-harness';
```

线程仓库与 ThreadService 在宿主侧：`@/backend/repositories/{thread-meta,runs}` / `@/backend/services/thread-service`。**禁止裸包名 import**（`import ... from '@deerflow/harness'`）：包无 main/exports，workspace symlink 会解析失败；eslint 已固化。发布为独立包后这条自然解除。
