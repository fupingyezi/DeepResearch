# mini-DeepResearch

一个基于 **Next.js 14 + LangChain / LangGraph 1.x** 构建的多智能体深度研究助手。

参考 **deer-flow 2.0** 的单一 lead-agent 形态：lead-agent 永远具备 subagent 能力（`task` 工具 + general-purpose subagent），由模型自主判断"简单直接答 / 复杂分解为并行 subagent"，不再依赖前端档位切换。前端提供聊天 + 思考时间线 + Artifact 浮窗产物面板的精致 UI。

## ✨ 主要特性

- 🤖 **单一 lead-agent，自主决策**：lead-agent 内置 `task("general-purpose", ...)` 能力，由模型自行判断是否拆解任务并调度 subagent 并行检索/汇总，无需前端切换"普通 / 联网 / 深度研究"模式。
- 🧠 **长期记忆系统**：LLM 驱动的事实提取与记忆更新（`workContext` / `personalContext` / `topOfMind` / `recentMonths` 等多 section + facts 数组），按 `agentName + userId` 分文件持久化到 `.memory/`。
- 🛰️ **进程内事件总线（StreamBridge）**：fire-and-forget 提交 Run，立即返回 `run_id`；ThreadChannel 缓冲 + 晚订阅回放，断线重连可补帧。SSE 协议白名单仅暴露 9 种 `ClientAgentEvent`。
- 💾 **完整持久化**：PostgreSQL 存 `threads` / `runs` 元数据 + LangGraph checkpoint（父子 subagent 共用 thread checkpoint）；Redis 缓存；MinIO 存上传文件。
- 🧩 **可装配的中间件管线**：`createBaseAgent` 按 `RuntimeFeatures` 组装最多 7 层中间件（Qwen 工具调用恢复、ToolError、Memory、SubagentLimit、LoopDetection、Clarification 等），支持 `@Next` / `@Prev` 装饰器自定义插入锚点。
- 📄 **思考时间线 + Artifact 浮窗**：聊天气泡内嵌折叠时间线（reasoning / tool_call / tool_result / task_progress），长报告自动收进右侧 Artifact 面板，避免淹没对话。
- 📁 **多格式文件上传**：PDF（pdf-parse）、Word（mammoth）、图片等，自动入 MinIO 并参与上下文。
- 📝 **完整 Markdown 渲染**：GFM、KaTeX 数学公式、代码高亮、长 URL/表格安全换行。

## 🛠️ 技术栈

| 层级       | 技术                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| 前端       | Next.js 14（App Router + Turbopack）、React 18、TypeScript、Ant Design 5、Zustand |
| 样式       | Tailwind CSS v4（`@theme inline` token）、`@tailwindcss/typography`               |
| Markdown   | react-markdown + remark-gfm/math + rehype-katex + react-syntax-highlighter        |
| Agent / AI | LangChain 1.x、LangGraph 1.x、`@langchain/langgraph-checkpoint-postgres`          |
| 模型       | `@langchain/openai`（OpenAI 兼容协议，支持 OpenAI / Qwen / Spark / DeepSeek 等）  |
| 检索       | Tavily（`@tavily/core`）                                                          |
| 存储       | PostgreSQL、Redis、MinIO                                                          |

## 📁 项目结构

```
src/
├── app/                                # Next.js App Router
│   ├── api/
│   │   ├── v3/chat/[threadId]/         # ⭐ 主聊天入口（SSE 流）
│   │   ├── threads/                    # 线程 CRUD / runs 列表
│   │   └── files/                      # 文件上传 / 删除
│   ├── globals.css                     # 全局样式 + 主题 token
│   ├── layout.tsx                      # 根布局（Sider + 主体）
│   └── page.tsx                        # 主页（聊天 + Artifact 浮窗）
│
├── components/                         # UI 组件（kebab-case）
│   ├── chat-window/                    # 聊天容器、消息列表、气泡、思考时间线、输入框
│   ├── markdown/                       # CustomMarkdown
│   ├── message-tool-bar/               # 复制 / 编辑 / 下载
│   ├── model-selector/                 # 模型切换
│   ├── files/                          # 文件上传 / 预览
│   ├── process/                        # Artifact 浮窗产物面板
│   └── sider/                          # 左侧会话侧边栏
│
├── deerflow-harness/                   # ⭐ 多智能体编排核心
│   ├── client.ts                       # DeerFlowClient：Agent 缓存 + LangGraph 流式调用
│   ├── agents/                         # Agent 工厂、中间件、记忆、特性装配
│   │   ├── factory.ts                  # createBaseAgent + assembleFromFeatures
│   │   ├── features.ts                 # RuntimeFeatures + Next/Prev 装饰器
│   │   └── memory/                     # MemoryUpdater（LLM 驱动）+ FileMemoryStorage
│   ├── subagents/                      # SubagentExecutor、注册表、general-purpose 内置
│   ├── runtime/                        # ThreadService、StreamBridge、SSE、Checkpointer
│   │   ├── service.ts                  # ThreadService（fire-and-forget 提交 + 状态收敛）
│   │   ├── stream-bridge/              # 进程内事件总线 + ThreadChannel（缓冲回放）
│   │   ├── sse/                        # ClientAgentEvent 白名单 + 内→外过滤
│   │   ├── checkpointer/               # PostgreSQL checkpoint 工厂
│   │   └── context.ts                  # AsyncLocalStorage 上下文传播
│   ├── persistence/                    # ThreadMetaStore + RunStore（PostgreSQL）
│   ├── tools/                          # 内置工具（task、search_web 等）
│   ├── models/                         # 模型预设（MODEL_PRESETS）
│   ├── mcp/ sandbox/ skills/ config/   # 待扩展能力
│   └── types/                          # AgentEvent 等共享类型
│
├── runtime/                            # 前端运行时（SSE 解析、EventBus、Context）
│   ├── client/                         # sse-frame-parser、event-bus
│   ├── context/                        # AgentEventContext + hooks
│   └── protocol/                       # ClientAgentEvent re-export（前后端共享协议）
│
├── store/                              # Zustand 切片
│   ├── conversation-store.ts           # 会话 / 消息 / 流式状态
│   ├── deep-research-process-store.ts  # 时间线 / 任务进度
│   ├── file-upload-store.ts            # 文件上传
│   └── modelStore.ts                   # 模型选择
│
├── lib/                                # 基础设施
│   ├── db/                             # PostgreSQL 连接池
│   ├── cache/                          # Redis 客户端
│   ├── storage/                        # MinIO 客户端
│   └── file-parser.ts                  # PDF / Word 解析
│
├── hooks/                              # 自定义 React hooks
├── utils/
│   ├── chat/                           # 流处理、parts collector / reducer、最终消息提取
│   ├── common/                         # message-content 等通用工具
│   ├── files/                          # 文件相关工具
│   └── request/                        # API 请求封装
├── types/                              # 全局类型
└── config/                             # 应用配置

docker-compose.yaml                     # PostgreSQL + Redis + MinIO 一键启动
CLAUDE.md                               # 架构与协作指引（详细版）
project.md                              # AI 协作代码规范
```

## 🚀 快速开始

### 环境要求

- **Node.js 18+**
- **pnpm**（推荐）
- **Docker & Docker Compose**

### 安装依赖

```bash
pnpm install
```

### 配置环境变量

在项目根目录创建 `.env`：

```env
# === 模型 API（OpenAI 兼容协议，任选其一或多个）===
OPENAI_API_KEY=your-openai-api-key
OPENAI_API_BASE=https://api.openai.com/v1

# 阿里千问（DashScope）
OPENAI_QWEN_API_KEY=your-qwen-api-key
OPENAI_QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_MODEL_NAME=qwen3-235b-a22b   # 默认模型

# 讯飞星火
OPENAI_SPARK_API_KEY=your-spark-api-key
OPENAI_SPARK_BASE_URL=https://spark-api-open.xf-yun.com/v1

# === 检索 ===
TAVILY_API_KEY=your-tavily-api-key

# === PostgreSQL ===
DATABASE_URL=postgresql://yezi:fupingyezi123@localhost:5432/mini-DeepResearch

# === Redis ===
REDIS_URL=redis://localhost:6379

# === MinIO ===
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=yezi
MINIO_SECRET_KEY=fupingyezi123
MINIO_BUCKET=chat-files
```

> `.env` 中的账密、端口需与 `docker-compose.yaml` 保持一致。模型预设位于 `src/deerflow-harness/models`，可通过请求 `metadata.modelKey` 切换。

### 启动基础设施

```bash
docker-compose up -d
```

会启动 PostgreSQL（5432）/ Redis（6379）/ MinIO（9000 数据端口、9001 控制台）。

### 启动开发服务器

```bash
pnpm dev
```

访问 [http://localhost:3000](http://localhost:3000)。

### 构建与运行生产版本

```bash
pnpm build
pnpm start
```

## 🔌 主要 API

| 路由                           | 方法       | 说明                                                             |
| ------------------------------ | ---------- | ---------------------------------------------------------------- |
| `/api/v3/chat/[threadId]`      | POST       | ⭐ 主聊天入口，SSE 流。响应头 `X-Run-Id` 立即可读，无需等待 body |
| `/api/threads`                 | POST/GET   | 创建线程；分页列出（`?limit=&offset=&status=`）                  |
| `/api/threads/[threadId]`      | GET/DELETE | 获取详情（可附带 checkpoint）/ 删除                              |
| `/api/threads/[threadId]/runs` | GET        | 列出线程下的 run                                                 |
| `/api/files/upload`            | POST       | multipart 上传，存 MinIO 并解析内容                              |
| `/api/files/delete`            | DELETE     | 从 MinIO 删除                                                    |

**主聊天请求体：**

```typescript
interface ChatBody {
  input: string; // 必填
  agentType?: string; // 默认 'lead'
  displayName?: string; // 线程显示名
  metadata?: {
    modelKey?: string; // 切换 MODEL_PRESETS 中的模型
    sessionId?: string;
    hasFiles?: boolean;
    uploadedFiles?: unknown[];
    [k: string]: unknown;
  };
}
```

**SSE 客户端事件白名单（9 种）：**

`start` / `stream_chunk` / `tool_call` / `tool_result` / `task_progress` / `human_interrupt` / `error` / `end` / `heartbeat`

协议定义：`src/deerflow-harness/runtime/sse/client-event.ts`，前端通过 `src/runtime/protocol/client-event.ts` re-export 复用。

## 🧩 架构要点

```
前端（React/Next.js + Zustand + EventBus）
        │ HTTP + SSE
        ▼
API Routes（/api/v3/chat/[threadId] 等）
        │
        ▼
ThreadService（fire-and-forget 提交 Run，立即返回 run_id）
   │ ├── DeerFlowClient（Agent 缓存 + LangGraph 流式调用）
   │ │      └── createBaseAgent + 中间件管线（最多 7 层）
   │ │             └── 工具：task / search_web / ...
   │ │                       └── SubagentExecutor（父子共用 checkpoint）
   │ ├── Checkpointer（PostgreSQL）
   │ └── Stores（threads / runs）
        │
        ▼
StreamBridge（进程内 EventEmitter 总线）
        └── ThreadChannel（buffer + 晚订阅回放）→ SSE → 前端
```

详细设计见 [`CLAUDE.md`](./CLAUDE.md)，包含：

- ThreadService 状态机与不变量（`try / catch / finally` 三段式收敛）
- Tool Call Chunk 缓冲机制（OpenAI 流式分片按 index 拼接）
- 中间件组装顺序与 `RuntimeFeatures` 开关
- Memory LLM 更新流程（含显式 `callbacks: []` 切断回调链的关键约束）
- ThreadMetaStore / RunStore 的 PG schema

## 📖 使用指南

### 对话

直接在输入框发送消息即可。lead-agent 会自主判断：

- **简单问题** → 直接回答，可能不调用任何工具
- **需要联网** → 自动调用 `search_web`
- **复杂研究** → 通过 `task("general-purpose", ...)` 启动一个或多个 subagent 并行检索，最终汇总报告

研究产出的完整报告自动收进右侧 **Artifact 浮窗面板**，气泡内仅保留入口卡片。

### 思考时间线

每条 AI 回复内嵌折叠时间线：

- 🟡 **思考**（reasoning）—— 模型规划文本
- 🔵 **工具调用**（tool_call / tool_result）—— 入参 / 错误 / 结果，搜索结果列表化
- 🟣 **任务进度**（task_progress）—— subagent 执行的 6 种状态：started / running / completed / failed / cancelled / timed_out

JSON 与搜索结果带最大高度与细滚动条，不会撑破气泡。

### 文件上传

输入框左侧回形针图标支持上传 PDF、Word、图片，文件解析后参与本轮对话上下文。

### 长期记忆

记忆按 `agentName + userId` 分文件存储到 `.memory/`，包含：

- `user.workContext / personalContext / topOfMind`
- `history.recentMonths / earlierContext / longTermBackground`
- `facts[]`：带 `category` / `confidence` / `source` 的事实条目

每轮对话由 `MemoryUpdater` 通过 LLM 提取并增量更新（含 JSON 修复、上传内容清洗、置信度过滤、casefold 去重）。

## 🛠️ 开发流程

```bash
# 代码检查
pnpm lint

# 格式化
pnpm format
pnpm format:check

# 构建
pnpm build

# 启用中间件调用日志（[mw] 前缀，覆盖整条管线 + task / qwen-recovery / loop-detection）
MW_TRACE=1 pnpm dev

# 打印完整 AI 输出（text + reasoning），用于排查模型输出截断 / 工具调用 chunk 问题
DEERFLOW_DEBUG=1 pnpm dev
# 或仅开 AI 输出日志
DEERFLOW_DEBUG_AI=1 pnpm dev

# 记忆系统调试日志（MemoryUpdater 的 LLM 调用、JSON 修复、增量更新落盘）
MEMORY_DEBUG=1 pnpm dev
```

其它运行期可调环境变量：

- `STREAM_BRIDGE_BUFFER_MAX` —— 单个 ThreadChannel 的事件 buffer 上限（默认无上限）
- `DEERFLOW_DATA_DIR` —— 记忆 / 数据落盘根目录，优先级高于默认的 `~/.deer-flow`

## 🧭 协作规范

代码风格、注释规范、命名约定、禁用项等详见 [`project.md`](./project.md)。要点：

- 持续高速迭代中，暂不维护任何兼容层，注释里出现 `legacy` / `deprecated` / `兼容` / `旧版` 等字眼必须连同代码一起删除
- `as unknown as T` 必须有解释性注释
- 业务缩写必须改全名（`tc → toolCall`、`cfg → config`、`msg → message` 等）
- 文件名一律 kebab-case
- 不可破坏的契约：SSE `ClientAgentEvent` 协议、API 路由、PG schema、Zustand store 字段、LangGraph runtime 配置 key

## ⚠️ 已知限制

1. `resume()` 尚未实现，调用直接抛异常（interrupt/resume 工作流待完成）
2. StreamBridge 为进程内总线，多实例水平扩展需替换为 Redis pub/sub
3. ThreadChannel buffer 无上限，超长运行的线程可能积累大量事件
4. 单次请求只能使用一个模型
5. `x-user-id` 仅用于数据过滤，无真正鉴权机制
6. 项目目前无单元测试

## 📝 License

MIT
