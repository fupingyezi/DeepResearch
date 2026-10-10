# @deerflow/harness

deerflow agent SDK——多智能体对话运行时（LangChain/LangGraph 1.x）：

- **单一 lead-agent 形态**：lead 永远具备 subagent 能力（`task` 工具 + general-purpose subagent），自主判断「简单直接答 / 并行分解」
- 中间件管线（`ORDERED_MIDDLEWARES` 位序装配：uploads / sandbox / guardrail / summarization / todo / title / memory / vision / loop-detection …）
- 事件系统：内部 `AgentEvent` → 客户端白名单 `ClientAgentEvent`（10 种）→ StreamBridge（每 run 一个 typed EventEmitter + 缓冲回放）→ RunEventBus（进程内 / Redis Stream 镜像双实现）
- ThreadService：fire-and-forget run 执行 + 取消三路径 + 优雅停机 + 僵尸回收 + 双层背压并发编排
- 记忆引擎：PG 双表存储 + LLM 驱动更新 + 双路召回（pgvector 向量 + BM25 词面）→ RRF → rerank 精排
- 沙箱（local / docker / remote 三后端）、视觉多模态、MCP / skill 扩展、LLM 用量记账

## 定位与边界

- **零 `@/` 依赖**：包内不含任何宿主应用代码（eslint `no-restricted-imports` 固化），可在任意 Node 项目复用
- **无 build 产物**：本仓库内经 tsconfig paths（`@deerflow-harness` / `@deerflow-harness/*`）直编译包源码；独立发布时补 tsup 构建与 main/exports 即可（TODO，见本仓库 plan）
- 上下文装配、沙箱装配、记忆检索都是**封装 API**：DB、模型配置、图片字节、Tavily、Redis 全部由宿主经注入面提供，包内不读宿主环境变量、不直连宿主存储

## 注入面（宿主装配清单）

全部 setter 走 globalThis 单例（Next dev HMR 分包安全），由宿主在组合根（本仓库为 `src/backend/wiring.ts`）注册一次：

| 接口                                                         | 宿主职责                                                         | 消费方 / 未注册行为                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `SqlExecutor`（`persistence/sql`）                           | 构造注入 `query` + `transaction` 最小 SQL 能力                   | `PgThreadMetaStore` / `PgRunStore` / `PgMemoryStorage`；构造即需实例                |
| `makeCheckpointer({ kind: 'postgres', postgres: { pool } })` | PG checkpoint saver（含 `saver.setup()`，池归宿主管理）          | ThreadService checkpointer                                                          |
| `setTitleStoreProvider`                                      | 标题读/写落库（`loadCurrentTitle` / `persistTitle`）             | title-middleware；未注册 warn 一次并跳过落库                                        |
| `setUploadedFilesProvider`                                   | 按 thread 装载上传文件内容                                       | thread-data-middleware / UploadsMiddleware；未注册 warn 一次，文件不注入            |
| `setRedisClientFactory`                                      | 按需构造 Redis 客户端（socket 选项由消费者自定）                 | event-bus / run-registry / dist-lock / docker-coordinator；未注册全部降级进程内实现 |
| `setTavilyApiKey`                                            | 联网搜索 Key                                                     | `search_web` 工具                                                                   |
| `setMemoryModelFactory` / `setTitleModelFactory`             | 记忆更新 / 标题生成 LLM                                          | 副链路；未注册静默降级                                                              |
| `setMemoryEmbeddingsFactory` / `setMemoryRerankerFactory`    | 向量化 / 精排 API                                                | 记忆检索；未注册回落词面 / 保持 RRF 序                                              |
| `setThreadImageFetcher`                                      | 图片字节读取（MinIO 等）                                         | vision 多模态注入                                                                   |
| `setParentHistoryProvider`                                   | 子 agent 父历史只读读取（checkpoint）                            | subagent 上下文注入                                                                 |
| `setMemoryStorage`                                           | 记忆存储后端                                                     | Noop 为默认：记忆功能关闭、聊天不阻断                                               |
| `setSandboxProvider`                                         | 沙箱后端（测试注入用）                                           | 默认 local                                                                          |
| `StreamBridge` 构造参数 `options.bufferMax`                  | 事件缓冲上限（默认 2000，`STREAM_BRIDGE_BUFFER_MAX` 由宿主解析） | ThreadChannel 缓冲回放                                                              |

本仓库的 app 侧实现：`src/backend/wiring.ts`（注册）+ `src/backend/harness-adapters/`（title-store / uploaded-files 的 SQL 实现）。

## 消费方式（本仓库内）

```ts
import {
  DeerFlowClient,
  makeCheckpointer,
  PgThreadMetaStore,
  SqlExecutor,
} from '@deerflow-harness';
```

**禁止裸包名 import**（`import ... from '@deerflow/harness'`）：包无 main/exports，workspace symlink 会解析失败；eslint 已固化。发布为独立包后这条自然解除。
