# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 项目概览

**Mini-DeepResearch** 是基于 **Next.js 14** 和 **LangChain/LangGraph** 构建的 AI 智能对话应用，核心能力包括：

- 多模型 AI 对话（支持 OpenAI、Qwen、Spark、DeepSeek 等 OpenAI 兼容接口）
- 单一 lead-agent 形态（对齐 deer-flow 2.0）：lead-agent 永远启用 subagent 能力（`task` 工具 + general-purpose subagent），由 agent 自主判断"简单直接答 / 复杂分解为并行 subagent"，不再有"联网搜索 / 深度研究"档位
- 持久化对话线程（PostgreSQL 存储元数据 + LangGraph Checkpoint 保存状态）
- 实时 SSE 事件流（fire-and-forget 执行 + StreamBridge 缓冲回放）
- 长期记忆系统（LLM 驱动的事实提取与更新）
- 文件上传与解析（MinIO 存储，支持 PDF/Word）
- 可插拔安全沙箱（`local` 宿主直连 / `docker` 每线程加固容器），配套多对话并行编排（双层背压 + 跨进程协调）

**技术栈：**

| 层级 | 技术                                                     |
| ---- | -------------------------------------------------------- |
| 前端 | Next.js 14、React 18、Ant Design 5、Zustand、TailwindCSS |
| 后端 | Node.js、LangChain.js、LangGraph                         |
| AI   | OpenAI API（兼容 Qwen、Spark、DeepSeek）                 |
| 存储 | PostgreSQL、Redis、MinIO                                 |
| 搜索 | Tavily API                                               |

---

## 常用命令

```bash
# 安装依赖
pnpm install

# 启动开发服务器（Turbopack，访问 http://localhost:3000）
pnpm dev

# 生产构建
pnpm build

# 启动生产服务器
pnpm start

# 代码检查
pnpm lint

# 代码格式化
pnpm format

# 检查格式化（不写入）
pnpm format:check

# 启动本地基础设施（PostgreSQL + Redis + MinIO）
docker-compose up -d
```

**注意：项目目前无单元测试。**

---

## 环境变量

从 `.env.example` 复制到 `.env` 后填写：

```env
# LLM API
OPENAI_API_KEY=...                        # OpenAI（可选）
OPENAI_QWEN_API_KEY=...                   # Qwen / Spark（阿里 DashScope）
OPENAI_QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_MODEL_NAME=qwen3-235b-a22b         # 默认模型

# 数据库
DATABASE_URL=postgresql://user:pass@localhost:5432/DeepResearch

# Redis
REDIS_URL=redis://localhost:6379

# 文件存储（MinIO）
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=chat-files

# 搜索
TAVILY_API_KEY=...

# 沙箱后端（可选，默认 local）
DEERFLOW_SANDBOX_BACKEND=local            # local（宿主直连）| docker（每线程加固容器）
DEERFLOW_ALLOW_HOST_BASH=false            # local 后端是否放行 host bash（docker 不受此门控）
DEERFLOW_MAX_CONCURRENT_RUNS=16           # run 级并发上限，超限对话回传 queued
DEERFLOW_DOCKER_IMAGE=python:3.12-slim-bookworm
DEERFLOW_DOCKER_MEMORY=2g
DEERFLOW_DOCKER_CPUS=1.5
DEERFLOW_DOCKER_NETWORK=bridge            # bridge（联网）| none（断网）
DEERFLOW_DOCKER_MAX_LIVE_CONTAINERS=32    # 容器级并发上限
DEERFLOW_SANDBOX_STATS_TOKEN=...          # GET /api/sandbox/stats 访问令牌（未设则禁用）
```

---

## TypeScript 路径别名

```
@/*                  →  ./src/*
@deerflow-harness/*  →  ./src/deerflow-harness/*
```

---

## 整体架构

```
┌──────────────────────────────────────────────────────────┐
│                 前端（React / Next.js）                   │
│  ChatWindow、ChatMessage、DeepResearch 进度面板            │
│  Zustand Store（conversation / deepResearch / files）     │
│  SSE 事件监听 → EventBus → React Context → UI 更新        │
└─────────────────────────┬────────────────────────────────┘
                          │ HTTP + SSE
          ┌───────────────┴────────────────┐
          │        API Routes              │
          │  POST /api/v3/chat/[threadId]  │  ← 主入口
          │  POST/GET /api/threads/...     │
          │  POST /api/files/upload        │
          └───────────────┬────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────┐
│        ThreadService（src/app/api/threads/_service.ts）  │
│  进程级单例，通过 getThreadService() 获取               │
│  8 个操作：createThread / listThreads / getThread /     │
│  deleteThread / submitRun / subscribe /                 │
│  getCheckpoint / resume（未实现）                       │
└────┬─────────────────┬──────────────────┬──────────────┘
     │                 │                  │
     ▼                 ▼                  ▼
DeerFlowClient    Checkpointer       Stores
(client.ts)       (LangGraph)     (PG / Redis)
Agent 缓存         Postgres / 内存  ThreadMeta
流式调用           保存对话状态      Runs
                                   Checkpoint
     │
     ▼
┌──────────────────────────────────────────────┐
│       Agent 执行流水线（LangGraph ReAct）      │
│  RunConcurrencyGate（run 级并发闸门，超限 queued） │
│  createBaseAgent() → assembleFromFeatures()   │
│  中间件链（按 ORDERED_MIDDLEWARES 位序，由 RuntimeFeatures 组装） │
│  工具：searchWebTool / taskTool / sandbox(读写/bash) / ... │
│  SandboxProvider：local 宿主直连 / docker 每线程加固容器 │
└──────────────────────────────────────────────┘
     │
     ▼
StreamBridge（进程内 EventEmitter 总线）
  └─ ThreadChannel（buffer + 晚订阅回放）
       └─ SSE 流 → 前端
```

---

## 核心组件详解

### 1. API 路由层

#### `POST /api/v3/chat/[threadId]`（主聊天接口）

**文件：** `src/app/api/v3/chat/[threadId]/route.ts`

三阶段管线：

1. **幂等创建线程**：以 `threadId` 为主键，若已存在则直接复用。
2. **提交 Run（fire-and-forget）**：`submitRun()` 立即返回 `run_id`，Agent 在后台异步执行。
3. **注入 START 帧并返回 SSE 流**：在 StreamBridge 订阅之上先 `yield` 一个携带 `run_id` 和 `thread_id` 的 START 事件，再转发后续事件。

Response Headers：

- `Content-Type: text/event-stream`
- `X-Run-Id: <run_id>`（客户端可在 headers 阶段立即拿到，无需等待 body）

请求体：

```typescript
interface ChatBody {
  input: string; // 必填
  agentType?: string; // Agent 标识，默认 'lead'
  displayName?: string; // 线程显示名
  metadata?: Record<string, any>; // 运行期开关，见 DeerFlowClient
}
```

`metadata` 中的运行期开关（影响本次 Agent 行为，不修改 baseOptions）：

- `modelKey: string` → 选择 MODEL_PRESETS 中的预设模型（不传走默认 preset）
- 其它业务字段（如 `sessionId`、`hasFiles`、`uploadedFiles`）按需透传

> 注：自 deer-flow 2.0 重构起，旧版 `is_plan_mode` / `subagent_enabled` /
> `agent_name` 三开关已废弃；lead-agent 永远启用 subagent 能力，由 agent 自主
> 判断是否分解任务并调用 `task("general-purpose", ...)`。

#### 其他路由

| 路由                           | 方法   | 说明                                              |
| ------------------------------ | ------ | ------------------------------------------------- |
| `/api/threads`                 | POST   | 创建线程；GET 分页列表（?limit=&offset=&status=） |
| `/api/threads/[threadId]`      | GET    | 获取线程详情（可附带 checkpoint）；DELETE 删除    |
| `/api/threads/[threadId]/runs` | GET    | 列出线程下的 run                                  |
| `/api/files/upload`            | POST   | multipart 上传，存 MinIO，解析内容                |
| `/api/files/delete`            | DELETE | 从 MinIO 删除文件                                 |

---

### 2. ThreadService

**文件：** `src/deerflow-harness/runtime/service.ts`  
**单例入口：** `src/app/api/threads/_service.ts` → `getThreadService()`

ThreadService 是整个系统的门面，装配 DeerFlowClient + Checkpointer + ThreadMetaStore + RunStore + StreamBridge + AsyncLocalStorage Context。

**关键不变量：**

- `submitRun` 立即返回 `run_id`，执行体 fire-and-forget（`void (async () => { ... })()`)
- 执行体通过 `try/catch/finally` 三重保障状态收敛：
  - 成功：`runs.setStatus('succeeded')` + `threads.updateStatus('idle')`
  - 失败：catch 中 publish ERROR 事件 → `runs.setStatus('failed')` + `threads.updateStatus('error')`
  - 兜底：finally 始终 publish END 事件（channel 自身对已关闭状态的 publish 是 no-op）
- `resume()` 目前为占位，调用直接抛异常

**线程状态机：**

```
idle → running → idle（成功）
              ↘ error（失败）
```

---

### 3. DeerFlowClient

**文件：** `src/deerflow-harness/client.ts`

进程级单例（注入到 ThreadService）。核心能力：

#### Agent 实例缓存

缓存键由以下字段组合（JSON.stringify）：

```typescript
[modelName, memoryEnabled, agentName, sortedSkills];
```

**重要例外：** `memoryEnabled=true` 时**不缓存**（每轮 prompt 含最新 memory，必须每次重建）。

#### 运行期选项解析（两级优先级）

`resolveRuntimeOptions(metadata)` 计算本轮 stream 的 `RuntimeRunOptions`：

1. `metadata` 中显式传入的开关（最高优先；仅 `memoryEnabled` 走运行期覆盖）
2. 构造时传入的 `baseOptions`（`_service.ts` 默认 `memoryEnabled: true`、`agentName: 'lead'`）

> 仅 `memoryEnabled` 支持运行期覆盖，且必须严格 `typeof === 'boolean'` 才生效——
> `metadata.memoryEnabled === undefined` 不会被解释为 false。`agentName` /
> `userId` / `availableSkills` 暂不开放单次请求覆盖。

并发安全：选项解析结果是局部变量，不修改 `this.baseOptions`。

#### stream() 方法的事件处理

使用 LangGraph `streamMode: ['messages', 'updates', 'custom']` 三模式同时订阅：

| streamMode | 内容                                               | 处理方式                                                           |
| ---------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| `messages` | AI token 分片（AIMessageChunk）                    | handleAiChunk：文本 → LLM_STREAM；tool_call_chunks → 按 index 缓冲 |
| `updates`  | 节点 state delta，含 ToolMessage                   | handleToolMessage：补发 TOOL_CALL_START + emit TOOL_CALL_RESULT    |
| `custom`   | 工具内部通过 LangGraph writer 推送的自定义 payload | handleCustomPayload：state*update / human_interrupt / task*\* 六种 |

**Tool Call Chunk 缓冲机制：**  
OpenAI 兼容模型流式输出时，同一工具调用的 `tool_call_chunks` 会按 `index` 分多片到达，args 字符串需拼接。`toolCallsByIndex` Map 按 index 累加 argsBuffer，当 ToolMessage 到达时才触发 TOOL_CALL_START 事件发送完整调用信息。

---

### 4. 事件系统（双层协议）

#### 内部事件（AgentEvent）

**文件：** `src/deerflow-harness/types/agent-event.ts`

框架内部使用，包含 20+ 个枚举值（`LIFECYCLE`、`NODE_ENTER`、`NODE_EXIT`、`LLM_STREAM`、`LLM_COMPLETE`、`TOOL_CALL_START`、`TOOL_CALL_RESULT`、`HUMAN_INTERRUPT`、`TASK_STARTED`、`TASK_RUNNING`、`TASK_COMPLETED`、`TASK_FAILED`、`TASK_CANCELLED`、`TASK_TIMED_OUT`、`ERROR` 等）。

#### 客户端事件（ClientAgentEvent）

**文件：** `src/deerflow-harness/runtime/sse/client-event.ts`

对外暴露的白名单协议（10 种），前端通过 `src/runtime/protocol/client-event.ts` 直接 re-export 复用：

| eventType         | payload                                         | 说明                        |
| ----------------- | ----------------------------------------------- | --------------------------- |
| `start`           | `{ sessionId?, run_id, thread_id }`             | 流式会话开始                |
| `stream_chunk`    | `{ text, reasoning? }`                          | LLM 增量文本                |
| `tool_call`       | `{ toolCallId, toolName, arguments? }`          | 工具调用开始                |
| `tool_result`     | `{ toolCallId, toolName, result, success }`     | 工具调用结果                |
| `task_progress`   | `{ taskId, status, message?, result?, error? }` | 折叠 6 种 task\_\* 内部事件 |
| `human_interrupt` | `{ question, details }`                         | 等待人工决策                |
| `error`           | `{ errorCode, errorMessage, recoverable }`      | 执行错误                    |
| `end`             | `{}`                                            | 流式会话结束                |
| `heartbeat`       | `{}`                                            | 保活心跳                    |

**过滤边界：** `src/deerflow-harness/runtime/sse/to-client-event.ts`  
内部事件 → 客户端事件的映射在此完成；不在白名单内的内部事件在此被 drop，不会泄露给前端。

---

### 5. StreamBridge（进程内事件总线）

**文件：** `src/deerflow-harness/runtime/stream-bridge/stream-bridge.ts`

#### 架构

```
StreamBridge（单例 streamBridge）
  └─ channels: Map<"threadId:runId", ThreadChannel>
       └─ ThreadChannel
            ├─ buffer: ClientAgentEvent[]   ← 历史事件缓冲
            ├─ EventEmitter（bus）           ← 实时事件推送
            └─ closed: boolean
```

#### 晚订阅回放机制

`ThreadChannel.subscribe()` 返回 `AsyncIterable`，其 `next()` 分四步：

1. **回放历史**：从 `buffered`（subscribe 时的快照）中按序返回
2. **消费待处理事件**：回放完后消费 `pending` 队列（回放期间新到达的事件）
3. **检查关闭状态**：若 channel 已关闭且无残留则终止迭代
4. **等待下一个事件**：挂起 Promise，等 bus 触发 `onEv` 回调

`setMaxListeners(0)` 防止多客户端同时订阅时出现 Node.js 警告。

#### 终止条件

- 收到 `END` 事件 → `close()`（channel 标记为 closed，后续 publish 是 no-op）
- `recoverable=false` 的 `ERROR` 事件 → 不立即 close，由后续的 END 兜底关闭

#### 水平扩展

注释明确：多实例部署时，将 `EventEmitter` 替换为 Redis pub/sub 即可，接口保持稳定。

---

### 6. Agent 工厂与中间件管线

**文件：** `src/deerflow-harness/agents/factory.ts`

#### `createBaseAgent(opts)`

接受 `CreateAgentOptions`，核心逻辑：

1. **互斥校验**：`middlewares` 与 `features` 不能同时指定；`middlewares` 与 `extraMiddlewares` 也不能同时指定。
2. **从 features 组装中间件链**（`assembleFromFeatures`）：见下表。
3. **工具去重合并**：`extraTools`（features 注入的 task 工具等）与 `tools` 合并，按工具 `name` 去重，避免重复注册。
4. **统一包日志**：`withCallLogAll()` 为所有中间件包一层调用日志（受 `MW_TRACE` 环境变量控制）。
5. **调用 `createAgent()`**：使用 `ThreadStateAnnotation` 作为 state schema。

#### 中间件组装规则（`assembleFromFeatures`）

按 `ORDERED_MIDDLEWARES` 位序装配（位序留白处为暂未挂的占位 guardrail 等）：

| 位序 | 中间件                           | 触发条件                                                                                                        |
| ---- | -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| —    | `QwenToolCallRecoveryMiddleware` | `features.qwenToolCallRecovery=true`，或 `provider='qwen'` 且 feature 未设置                                    |
| 0    | `ThreadDataMiddleware`           | `features.threadData=true`（服务级默认 true）；beforeAgent 从 `file_metadata` 装载 uploadedFiles                |
| 1    | `UploadsMiddleware`              | `features.uploads=true`（服务级默认 true）；把 uploadedFiles 渲染为 SystemMessage 注入 prompt（防重 tag）       |
| 2    | `SandboxMiddleware`              | `features.sandbox=true`；beforeAgent `retain`(+1) / afterAgent `markIdle`(-1) 维护容器引用计数（docker 后端）    |
| 3    | `DanglingToolCallMiddleware`     | 始终启用                                                                                                        |
| 5    | `ToolErrorHandlingMiddleware`    | 始终启用                                                                                                        |
| 6    | `SummarizationMiddleware`        | `features.summarization` = `createSummarizationMiddleware()` 实例（不允许 true）                                |
| 7    | `TodoMiddleware`                 | `features.todo=true`（默认关闭，开启后注入 `write_todos` 工具 + ThreadState.todos）                             |
| 8    | `TitleMiddleware`                | `features.autoTitle=true`（服务级默认 true）；afterAgent 用固定小模型异步生成标题，落 chat_session/threads_meta |
| 9    | `MemoryMiddleware`               | `features.memory=true`（服务级默认 true）                                                                       |
| 10   | `ViewImageMiddleware`            | `features.vision=true`（默认关闭；当前为占位 + 启用警告，等视觉模型适配再做）                                   |
| 11   | `SubagentLimitMiddleware`        | 始终启用（lead-agent 永远具备 task 能力，需要并发/总量上限兜底）                                                |
| 12   | `LoopDetectionMiddleware`        | 始终启用                                                                                                        |

同时，`taskTool` 始终注入到 `extraTools`；`features.sandbox` 启用时，7 个沙箱文件/执行工具（`SANDBOX_TOOLS`）注入 lead-agent 工具集（subagent 经工具注册表继承）。

#### RuntimeFeatures 类型

```typescript
type FeatureToggle<M> = false | true | M; // false=禁用 / true=默认实现 / M=自定义中间件

interface RuntimeFeatures {
  sandbox?: FeatureToggle;
  memory?: FeatureToggle;
  summarization?: FeatureToggle; // 不允许 true（须传 createSummarizationMiddleware 实例）
  todo?: FeatureToggle;
  vision?: FeatureToggle; // viewImageMiddleware（当前为占位）
  autoTitle?: FeatureToggle;
  threadData?: FeatureToggle; // 装载 file_metadata 到 state.uploadedFiles
  uploads?: FeatureToggle; // 注入 uploadedFiles 到 prompt（SystemMessage）
  guardrail?: FeatureToggle; // 不允许 true
  qwenToolCallRecovery?: FeatureToggle;
}
```

`Next<T>` / `Prev<T>` 装饰器可为自定义中间件指定插入锚点（插入到某中间件之前/之后）。

---

### 7. Subagent 系统

**文件：**

- `src/deerflow-harness/subagents/config.ts` — `SubagentConfig` 接口
- `src/deerflow-harness/subagents/executor.ts` — `SubagentExecutor`
- `src/deerflow-harness/subagents/registry.ts` — 运行时注册表
- `src/deerflow-harness/subagents/builtins/general-purpose.ts` — 内置 general-purpose subagent（对齐 deer-flow 2.0 `general_purpose.py`：`tools=undefined` 继承 lead 工具集 + `disabledTools=['task']` 防递归 + `model='inherit'` 复用 lead modelConfig）

#### SubagentExecutor

无全局状态（不维护后台 Map / 轮询）。每次 `execute(prompt, parentSignal)` 独立构造 Agent 实例，不复用缓存。

信号组合：`parentSignal`（来自请求中止）+ 内部 timeout timer 各自 abort 同一个 `internalController`。

终态事件（至多 yield 一次）：`completed` / `failed` / `timed_out` / `cancelled`。

父子共用 Checkpoint：若处于 thread 上下文中，`ctxThreadId` 会透传给子图，使父子 Agent 共用同一 checkpoint thread。

#### 内置工具与 task\_\* 自定义事件

`taskTool` 通过 LangGraph `writer`（custom stream）推送以下类型的 payload：

```
task_started / task_running / task_completed / task_failed / task_cancelled / task_timed_out
```

这些 payload 在 `DeerFlowClient.handleCustomPayload()` 中被映射为内部 `AgentEvent`，再由 `to-client-event.ts` 折叠为 `TASK_PROGRESS` 事件发给前端。

---

### 8. 记忆系统（Memory）

**文件：** `src/deerflow-harness/agents/memory/`

#### 数据结构（MemoryData）

```typescript
{
  user: {
    workContext: {
      summary: string;
      updatedAt: string;
    }
    personalContext: {
      summary: string;
      updatedAt: string;
    }
    topOfMind: {
      summary: string;
      updatedAt: string;
    }
  }
  history: {
    recentMonths: {
      summary: string;
      updatedAt: string;
    }
    earlierContext: {
      summary: string;
      updatedAt: string;
    }
    longTermBackground: {
      summary: string;
      updatedAt: string;
    }
  }
  facts: Array<{
    id: string; // 'fact_' + 8 位 UUID
    content: string;
    category: FactCategory; // 'context' | 'preference' | 'behavior' | 'correction' 等
    confidence: number; // [0, 1]
    createdAt: string; // ISO UTC
    source: string; // threadId 或 'manual' 或 'unknown'
    sourceError?: string;
  }>;
}
```

#### 默认存储

`FileMemoryStorage`：JSON 文件存储于项目根目录下的 `.memory/` 目录，按 `agentName` + `userId` 分隔文件。可通过 `getMemoryStorage()` 替换为其他实现。

#### LLM 驱动更新流程（MemoryUpdater）

1. 加载当前 memory
2. 拼装 prompt（`MEMORY_UPDATE_PROMPT`）：注入 `{current_memory}` + `{conversation}` + `{correction_hint}`
3. LLM invoke（**关键：显式 `callbacks: []`**，切断与外层 SSE handler 的 callback 链，防止向已关闭的 ReadableStream 写入触发 `ERR_INVALID_STATE`）
4. 解析 LLM 输出 JSON（含 JSON 修复兜底 `tryRecoverJson`，处理 Qwen 在 maxTokens 触顶时尾部截断）
5. `applyUpdates()`：更新 user/history sections，增删 facts（按 confidence 过滤 + casefold 去重 + maxFacts 截断）
6. `stripUploadMentions()`：清洗文件上传相关内容，防止文件引用污染长期记忆
7. 保存到 storage

校正提示（`correctionDetected` / `reinforcementDetected`）：检测对话中的纠错/正强化信号时自动注入额外的 LLM 提示，提升记忆更新质量。

#### Memory 手动 CRUD API

```typescript
getMemoryData(agentName, userId): Promise<MemoryData>
clearMemoryData(agentName, userId): Promise<MemoryData>
createMemoryFact(content, category, confidence, agentName, userId): Promise<MemoryData>
updateMemoryFact(factId, patch, agentName, userId): Promise<MemoryData>
deleteMemoryFact(factId, agentName, userId): Promise<MemoryData>
```

---

### 8.5 MCP 与 Skill 扩展子系统（extensions）

参考 deer-flow，提供两类可在设置界面管理的扩展能力，统一由仓库根目录的文件式配置驱动。

#### 统一配置

**文件：** `src/deerflow-harness/extensions/`（`types.ts` / `paths.ts` / `config-store.ts`）

- 配置文件：`extensions_config.json`（路径可由 `DEERFLOW_EXTENSIONS_CONFIG_PATH` 覆盖，默认 `{cwd}/extensions_config.json`），含 `mcpServers` 与 `skills` 两个 map，模板见 `extensions_config.example.json`。
- `FileExtensionsConfigStore` 复用 memory 的 FileStorage 范式：mtime 缓存 + 原子写（tmp→rename）+ schema 校验失败回退空配置。Zod schema（`mcpServerConfigSchema` 等）同时用于 API 入参校验。
- `extensions_config.json` 与 `skills/custom` 为运行期状态，已 gitignore。

#### Skill 子系统（Prompt 注入式，无沙箱）

**文件：** `src/deerflow-harness/skills/`（`frontmatter.ts` / `loader.ts` / `prompt.ts`）

- 扫描 `skills/public|custom/<name>/SKILL.md`，自写最小 frontmatter 解析器（不引入 js-yaml）提取 `name`/`description`，正文用于 prompt 注入。
- `loadEnabledSkills()` 合并配置中的 enabled 状态；**默认禁用（opt-in）**——启用即把 SKILL.md 正文注入系统提示，有 token 成本，与 deer-flow 沙箱场景默认启用不同。
- 注入点：`buildLeadAgentSystemPrompt()` 拼装 `<available_skills>` section（顺序：BASE_SYSTEM_PROMPT → skills → memory），skill 加载失败降级为无 skill。

#### MCP 子系统（端到端）

**文件：** `src/deerflow-harness/mcp/client.ts`（依赖 `@langchain/mcp-adapters`）

- 按启用的 MCP server 构建 `MultiServerMCPClient` 加载工具；`env`/`headers` 中的 `$VAR` 用 `process.env` 解析（未命中替换为空串）。
- 关键不变量：`throwOnLoadError: false`（单服务器失败跳过，不阻断对话）；`prefixToolNameWithServerName: true`（防与内置工具重名）；按「启用 server 配置签名」缓存 client，签名变化才重连。
- 接入：`DeerFlowClient.ensureAgent()` 在 stream 首帧前 **await** `loadMcpTools()` 并入工具集（满足 §8）；`buildConfigKey()` 纳入 MCP/skill 启用签名，配置变更后（关闭 memory 的可缓存场景）agent 自动重建。
- 运行时：stdio 类型 server 需 spawn 子进程，相关 API 路由显式 `export const runtime = 'nodejs'`。

#### 管理 API 与设置界面

- `GET/POST /api/mcp`、`PATCH/DELETE /api/mcp/[name]`：MCP server CRUD 与启用切换（写后 `resetMcpClient()` 失效缓存）。
- `GET/POST /api/skills`、`PATCH /api/skills/[name]`：skill 列表、新建自定义 skill、启用切换。
- 设置弹窗：「技能」页（`skill-settings-page.tsx`，public/custom 分组 + 新建表单）、「工具」页 MCP 区（`mcp-servers-section.tsx`，列表 + 启用开关 + 增删改表单）。

---

### 8.6 安全沙箱与多对话并行编排（sandbox）

**文件：** `src/deerflow-harness/sandbox/`

沙箱为 Agent 提供受限的文件读写/搜索/list/bash 执行环境（路径安全校验 + 文件操作锁 + 异常隔离），后端可插拔。

#### 后端工厂（provider-factory）

**文件：** `src/deerflow-harness/sandbox/provider-factory.ts`

进程级单例，按 `DEERFLOW_SANDBOX_BACKEND` 选后端（`getSandboxProvider()` / `resetSandboxProvider()` / `setSandboxProvider()` 供测试注入）：

- `local`（默认）：`LocalSandboxProvider`，宿主文件系统直连；bash 直接在宿主执行，受 `DEERFLOW_ALLOW_HOST_BASH` 门控。
- `docker`：`DockerSandboxProvider`，每 thread 一个长驻加固容器；bash 在容器内执行，具内核级隔离，**不受 host-bash 门控**。

依赖方向 `factory → local / docker`、`docker → local`（`DockerSandbox extends LocalSandbox`，仅重写 `executeCommand` 走 `docker exec`），均单向无循环。

`SandboxProvider` 基类关键方法：`acquire` / `release`（abstract）+ 默认 no-op 的 `retain` / `markIdle` / `heartbeat` / `releaseByThreadId` + `isSecureIsolation()`（默认 `false`，Docker 覆盖为 `true`，用于 `bashTool` 判断是否跳过 host-bash 门控）。

#### Docker 后端（docker/）

- `docker-config.ts`：env-only 配置（前缀 `DEERFLOW_DOCKER_*`），含镜像、内存/CPU/pids 限额、网络模式、空闲回收、并发上限、锁 TTL、只读根 + tmpfs 等。
- `docker-cli.ts`：`runDocker()` 用 `execFile` + 参数数组（禁 shell 拼接防注入），另有 `dockerPsByPrefix` / `dockerStats` / `runDockerWithRetry`。
- `docker-sandbox-provider.ts`：每 thread 一个 `sleep infinity` 加固容器（`--cap-drop ALL` + `--security-opt no-new-privileges` + `--memory/--cpus/--pids-limit` + `--user 1000:1000` 降权）；卷挂载 `{threadDir}/user-data → /mnt/user-data`（不暴露宿主真实路径，`DockerSandbox` 内做路径反向映射）；引用计数 + 空闲回收 + LRU + 容器消失时 reprovision 重建。
- `docker-coordinator.ts`：跨进程协调。Redis 原子计数（containers/runs count 用 Lua RESERVE/RELEASE）、thread→container 登记 Hash、`SET NX PX` 分布式锁；**Redis 不可用自动降级进程内 Map**。

#### 多对话并行编排（双层背压）

`submitRun` 是 fire-and-forget，此前无背压。现引入双层：

- **run 级**：`runtime/run-concurrency-gate.ts`（`RunConcurrencyGate` 进程级单例）。本进程 FIFO 信号量 + 跨进程 `runs:count` 占位；接在 `service.ts` 执行体消费 stream 之前 `acquire`，超限先 publish `task_progress{status:'queued'}`（对话仍可先思考），`finally` 释放。`DEERFLOW_MAX_CONCURRENT_RUNS` 控制上限（默认 16）。
- **容器级**：`DEERFLOW_DOCKER_MAX_LIVE_CONTAINERS` 活跃容器数上限（默认 32），配合空闲回收器（`refCount==0` 且空闲超 `idleTimeoutMs`）与启动 `reconcile()` 清孤儿容器。

引用计数不变式：`refCount` = 正在使用容器的 run/agent 层数，由 `sandbox-middleware` 的 `beforeAgent` retain(+1) 与 `afterAgent` markIdle(-1) 严格成对；`acquire` 幂等命中只 touch 不 incRef（避免 subagent/工具惰性 acquire 泄漏）。`deleteThread` 联动 `releaseByThreadId` 销毁容器。

#### 监控

`sandbox/sandbox-monitor.ts`（`getSandboxSnapshot`）+ `app/api/sandbox/stats/route.ts`（`GET`，`DEERFLOW_SANDBOX_STATS_TOKEN` 门控，`runtime='nodejs'`）暴露容器/并发运行态快照。

> 完整设计见 [`docs/sandbox-implementation.md`](./docs/sandbox-implementation.md)（§10 为并行编排方案）。

---


**文件：** `src/deerflow-harness/persistence/thread-meta/postgres-store.ts`

```sql
-- threads 表（参考 PgThreadMetaStore 实现）
CREATE TABLE threads (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  assistant_id TEXT,
  display_name TEXT,
  status      TEXT,    -- 'idle' | 'running' | 'error' | 'interrupted'
  metadata    JSONB,
  created_at  TIMESTAMP WITH TIME ZONE,
  updated_at  TIMESTAMP WITH TIME ZONE
);
```

`metadata` 字段使用 PostgreSQL `jsonb @>` 操作符支持灵活过滤（`search()` 方法）。所有操作均携带 `user_id` 做访问控制（存在性校验）。

#### RunStore（PostgreSQL）

**文件：** `src/deerflow-harness/persistence/runs/postgres-store.ts`

```sql
-- runs 表
CREATE TABLE runs (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT REFERENCES threads(id),
  assistant_id TEXT,
  user_id      TEXT,
  input        TEXT,
  status       TEXT,    -- 'running' | 'succeeded' | 'failed'
  error        TEXT,
  metadata     JSONB,
  created_at   TIMESTAMP WITH TIME ZONE,
  updated_at   TIMESTAMP WITH TIME ZONE
);
```

#### Checkpointer（LangGraph）

由 `@langchain/langgraph-checkpoint-postgres` 管理，保存 LangGraph ReAct Agent 的完整状态快照（messages、tool_calls 等）。工厂函数：`makeCheckpointer()`（`src/deerflow-harness/runtime/checkpointer/factory.ts`）。

---

### 10. 前端状态管理（Zustand）

**文件：** `src/store/`

#### chatSessionStore（多对话并行状态隔离）

**文件：** `src/store/chat-session-store.ts`

为支持「切换对话后正在跑的对话不中断、侧栏按运行态显示 loading/绿点」，采用**分桶为真相源 + 当前视图投影**的模型：

- `sessionRuntimes: Record<sessionId, { messages, status: 'idle'|'running'|'done'|'error', abortController, lastActiveAt }>`：每个对话一个独立运行桶（真并行的真相源）。
- 按 sessionId 的 action：`setSessionMessages` / `setSessionStatus` / `setSessionAbortController` / `getSessionRuntime` / `migrateSessionRuntime`（临时 id → 真实 id）/ `abortSession`。
- `currentMessages` / `isChating` / `currentAbortController` 降级为「`currentSessionId` 桶的投影」；`setCurrentSessionId` 切换时从桶恢复投影（含正在跑的消息与运行态），彻底避免全局单例被切走的对话覆盖。

`StreamChatHandler`（`src/utils/chat/stream-chat-handler.ts`）全程用 `this.sessionId` 作桶 key 写回；`applyStartEvent` 用 `migrateSessionRuntime` 衔接新建对话的临时 id 与后端真实 id（不再强行 `setCurrentSessionId` 把用户拽回）。侧栏 `sider-content.tsx` 的 `SessionStatusIndicator` 订阅 `sessionRuntimes[id]?.status` 显示运行态。

#### fileUploadStore

管理已上传文件列表与上传进度状态。

---

### 11. 前端 SSE 事件处理链

```
fetch() POST /api/v3/chat/[threadId]
    ↓
src/utils/chat/stream-chat-handler.ts（StreamChatHandler）
    ↓
src/runtime/client/sse-frame-parser.ts（逐行解析 data: JSON 帧）
    ↓
src/runtime/client/event-bus.ts（EventBus，广播到所有订阅者）
    ↓
src/runtime/context/agent-event-context.tsx（React Context）
    ↓
useAgentEvent() hook / useAgentEventListener()
    ↓
组件更新（ChatMessage、DeepResearch 面板等）
```

---

## 关键设计模式

### 1. 进程级单例服务

```typescript
// src/app/api/threads/_service.ts
let service: ThreadService | null = null;
export async function getThreadService(): Promise<ThreadService> {
  if (service) return service;
  // 懒加载初始化：DeerFlowClient + Checkpointer + Stores
  service = createThreadService({ client, checkpointer, threads, runs });
  return service;
}
```

Memory 的模型工厂也在此处注入：`setMemoryModelFactory(factory)`。

### 2. AsyncLocalStorage 上下文传播

```typescript
// src/deerflow-harness/runtime/context.ts
// runWithContext() 在整个 Agent 调用栈中提供 threadId / runId / userId
runWithContext(ctx, async () => {
  const ctx = getContext(); // 任意深度的调用中都可访问
});
```

SubagentExecutor 通过 `getContext()?.thread_id` 读取父线程 ID，实现父子共用 Checkpoint。

### 3. 中间件定位装饰器

```typescript
// 可将自定义中间件插入到指定中间件之前/之后
@Next(LoopDetectionMiddleware)  // 插入到 LoopDetection 之后
@Prev(ClarificationMiddleware)  // 插入到 Clarification 之前
class MyCustomMiddleware extends AgentMiddleware { ... }
```

### 4. 幂等线程创建

前端生成 `threadId`（UUID）后调用 `POST /api/v3/chat/[threadId]`。`createThread()` 先查询再决定是否写入，外部指定 ID 的场景天然支持请求重试。

---

## 调试技巧

### 启用中间件调用日志

```bash
MW_TRACE=1 pnpm dev
```

控制台会输出所有中间件被调用的日志（`[mw]` 前缀）。

### 查看 Agent 绑定的工具

启动时控制台自动打印（`[agent]` 前缀）：

```
[agent] tools bound to LLM (3): search_web, task, ask_clarification
```

### 手动测试 API

```bash
# 创建线程
curl -X POST http://localhost:3000/api/threads \
  -H "Content-Type: application/json" \
  -d '{"display_name": "测试线程"}'

# 发送消息（SSE 流）— 由 lead-agent 自主判断是否进入深度研究
curl -X POST http://localhost:3000/api/v3/chat/thread-123 \
  -H "Content-Type: application/json" \
  -d '{"input": "什么是 LangChain？"}' \
  -H 'Accept: text/event-stream' \
  --no-buffer

# 切换模型（其余字段同上）
curl -X POST http://localhost:3000/api/v3/chat/thread-456 \
  -H "Content-Type: application/json" \
  -d '{"input": "研究量子计算趋势", "metadata": {"modelKey": "deepseek-v4-pro"}}' \
  -H 'Accept: text/event-stream' \
  --no-buffer
```

### 查看数据库

```bash
# 查看线程
psql $DATABASE_URL -c "SELECT id, status, display_name, created_at FROM threads ORDER BY created_at DESC LIMIT 20;"

# 查看 runs
psql $DATABASE_URL -c "SELECT id, thread_id, status, created_at FROM runs WHERE thread_id = '...';"
```

### 查看 Memory 文件

```
.memory/
├── agent-memory-lead.json        # lead agent 的记忆
├── user-memory-{userId}.json     # 按用户隔离的记忆
└── ...
```

---

## 关键文件索引

| 文件                                                          | 职责                                      |
| ------------------------------------------------------------- | ----------------------------------------- |
| `src/app/api/threads/_service.ts`                             | ThreadService 进程单例工厂                |
| `src/app/api/v3/chat/[threadId]/route.ts`                     | 主聊天 API，三阶段管线                    |
| `src/deerflow-harness/client.ts`                              | DeerFlowClient，Agent 缓存 + 流式调用     |
| `src/deerflow-harness/runtime/service.ts`                     | ThreadService 接口定义与实现              |
| `src/deerflow-harness/agents/factory.ts`                      | createBaseAgent + assembleFromFeatures    |
| `src/deerflow-harness/agents/features.ts`                     | RuntimeFeatures + Next/Prev 装饰器        |
| `src/deerflow-harness/runtime/stream-bridge/stream-bridge.ts` | StreamBridge + ThreadChannel（缓冲回放）  |
| `src/deerflow-harness/runtime/sse/client-event.ts`            | ClientAgentEvent 白名单协议（前后端共用） |
| `src/deerflow-harness/runtime/sse/to-client-event.ts`         | 内部事件 → 客户端事件的过滤边界           |
| `src/deerflow-harness/types/agent-event.ts`                   | AgentEvent 内部事件枚举                   |
| `src/deerflow-harness/agents/memory/updater.ts`               | MemoryUpdater（LLM 驱动记忆更新）         |
| `src/deerflow-harness/subagents/executor.ts`                  | SubagentExecutor（子代理执行，超时+取消） |
| `src/deerflow-harness/extensions/config-store.ts`             | extensions_config.json 文件存储（MCP/skill 统一配置） |
| `src/deerflow-harness/skills/loader.ts`                       | skill 加载器（扫描 SKILL.md + 合并启用状态）   |
| `src/deerflow-harness/mcp/client.ts`                          | MCP 客户端封装（加载工具 + 失败容错 + 缓存）   |
| `src/deerflow-harness/sandbox/provider-factory.ts`           | 沙箱后端工厂（按 DEERFLOW_SANDBOX_BACKEND 选 local/docker） |
| `src/deerflow-harness/sandbox/docker/docker-sandbox-provider.ts` | Docker 后端（每线程加固容器 + 引用计数 + 空闲回收） |
| `src/deerflow-harness/sandbox/docker/docker-coordinator.ts`  | 跨进程沙箱协调（Redis 计数/登记/锁，可降级进程内） |
| `src/deerflow-harness/runtime/run-concurrency-gate.ts`       | run 级并发闸门（FIFO 信号量 + 跨进程占位）     |
| `src/deerflow-harness/runtime/context.ts`                     | AsyncLocalStorage 上下文传播              |
| `src/store/chat-session-store.ts`                             | 前端聊天会话状态（sessionRuntimes 分桶并行） |
| `src/utils/chat/stream-chat-handler.ts`                       | 前端 SSE 流处理                           |

---

## 已知限制

1. `resume()` 尚未实现，调用直接抛出异常（interrupt/resume 工作流待完成）
2. StreamBridge 为进程内总线，不支持多实例水平扩展（需替换为 Redis pub/sub）
3. ThreadChannel 的 buffer 无上限，超长运行的线程可能积累大量事件
4. 单次请求只能使用一个模型（不支持混合 Qwen + OpenAI）
5. `x-user-id` 仅用于数据过滤，无真正的鉴权机制
