# DeepResearch

一个基于 **Next.js 14 + LangChain / LangGraph 1.x** 构建的多智能体深度研究助手。

参考 **deer-flow 2.0** 的单一 lead-agent 形态：lead-agent 永远具备 subagent 能力（`task` 工具 + general-purpose subagent），由模型自主判断"简单直接答 / 复杂分解为并行 subagent"，不再依赖前端档位切换。前端提供聊天 + 思考时间线 + Artifact 浮窗产物面板 + 设置管理界面的精致 UI。

## ✨ 主要特性

- 🤖 **单一 lead-agent，自主决策**：lead-agent 内置 `task("general-purpose", ...)` 能力，由模型自行判断是否拆解任务并调度 subagent 并行检索/汇总，无需前端切换"普通 / 联网 / 深度研究"模式。
- 🔐 **用户认证系统**：JWT 鉴权 + OAuth 第三方登录（注册 / 登录 / 修改密码 / 会话管理），`x-user-id` 数据隔离。
- 🧠 **长期记忆系统**：LLM 驱动的事实提取与记忆更新（`workContext` / `personalContext` / `topOfMind` / `recentMonths` 等多 section + facts 数组），按 `agentName + userId` 分文件持久化到 `.memory/`；支持通过 API 或设置界面手动 CRUD 记忆事实。
- 🔌 **MCP 服务器扩展**：通过 `@langchain/mcp-adapters` 接入外部 MCP server（stdio / HTTP），动态加载工具并注入 Agent 工具集；支持在设置界面管理启停。
- 🧩 **Skill 技能系统**：Prompt 注入式扩展能力，内置 7 种技能（深度研究、咨询分析、代码文档、学术论文评审、新闻稿生成、前端设计、Web 设计指南），扫描 `skills/public|custom/<name>/SKILL.md`，将技能说明注入系统提示；opt-in 默认关闭以节省 token。
- 🛰️ **进程内事件总线（StreamBridge）**：fire-and-forget 提交 Run，立即返回 `run_id`；ThreadChannel 缓冲 + 晚订阅回放，断线重连可补帧。SSE 协议白名单仅暴露 10 种 `ClientAgentEvent`。
- 💾 **完整持久化**：PostgreSQL 存 `threads` / `runs` 元数据 + LangGraph checkpoint（父子 subagent 共用 thread checkpoint）；Redis 缓存；MinIO 存上传文件。
- 🧩 **可装配的中间件管线**：`createBaseAgent` 按 `RuntimeFeatures` 组装最多 14 层中间件（Qwen 工具调用恢复、ToolError、Memory、SubagentLimit、LoopDetection、Guardrail、Title、Todo、Summarization、Clarification、ViewImage、Uploads、ThreadData、Sandbox 等），支持 `@Next` / `@Prev` 装饰器自定义插入锚点；含 Tool Call 完整性子规则（悬空调用检测 + 未知调用检测）。
- 📄 **思考时间线 + Artifact 浮窗**：聊天气泡内嵌折叠时间线（reasoning / tool_call / tool_result / task_progress），长报告自动收进右侧 Artifact 面板，避免淹没对话。
- 📁 **多格式文件上传**：PDF（pdf-parse）、Word（mammoth）、图片等，自动入 MinIO 并参与上下文。
- 📝 **完整 Markdown 渲染**：GFM、KaTeX 数学公式、代码高亮、长 URL/表格安全换行。
- 🔒 **安全沙箱**：内置路径安全校验、文件操作锁（并发控制）、异常隔离的受限执行环境；支持读写/搜索/list 等沙箱工具集。
- 📊 **基准测试框架**：`benchmarks/` 内置评估系统 + 研究 QA 数据集，支持 Agent 质量打分与结果持久化。

## 🛠️ 技术栈

| 层级       | 技术                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------- |
| 前端       | Next.js 14（App Router + Turbopack）、React 18、TypeScript、Ant Design 5、Zustand           |
| 样式       | Tailwind CSS v4（`@theme inline` token）、`@tailwindcss/typography`                         |
| Markdown   | react-markdown + remark-gfm/math + rehype-katex + react-syntax-highlighter                  |
| 图标       | Lucide React                                                                                |
| Agent / AI | LangChain 1.x、LangGraph 1.x、`@langchain/langgraph-checkpoint-postgres`                    |
| 模型       | `@langchain/openai`（OpenAI 兼容协议，支持 OpenAI / Qwen / Spark / DeepSeek / Moonshot 等） |
| 检索       | Tavily（`@tavily/core`）                                                                    |
| MCP        | `@langchain/mcp-adapters`                                                                   |
| 状态管理   | Zustand + Immer                                                                             |
| 校验       | Zod                                                                                          |
| 导出       | jsPDF + html2canvas                                                                         |
| 存储       | PostgreSQL、Redis、MinIO                                                                    |
| 鉴权       | JWT（jsonwebtoken）、bcryptjs                                                               |

## 📁 项目结构

```
src/
├── app/                                # Next.js App Router
│   ├── (app)/                          # 主应用路由组（需认证）
│   │   ├── layout.tsx                  # 应用布局
│   │   └── page.tsx                    # ⭐ 主页（聊天 + Artifact 浮窗）
│   ├── (auth)/                         # 认证路由组（公开页面）
│   ├── api/                            # API 路由
│   │   ├── v3/chat/[threadId]/         # ⭐ 主聊天入口（SSE 流）
│   │   ├── threads/                    # 线程 CRUD / runs 列表 / SSE 流回放
│   │   ├── conversations/              # 对话会话管理（获取/历史/更新）
│   │   ├── files/                      # 文件上传 / 删除
│   │   ├── memory/                     # 记忆数据查询 / facts CRUD
│   │   ├── mcp/                        # MCP 服务器管理（CRUD + 启停）
│   │   ├── skills/                     # 技能管理（列表 / 新建 / 启停）
│   │   ├── tools/                      # 已绑定工具列表
│   │   └── auth/                       # 用户认证（注册/登录/OAuth/密码修改/初始化）
│   ├── globals.css                     # 全局样式 + 主题 token
│   └── layout.tsx                      # 根布局（Sider + 主体）
│
├── components/                         # UI 组件（kebab-case）
│   ├── chat-window/                    # 聊天窗口、输入框、消息气泡、思考时间线
│   ├── markdown/                       # CustomMarkdown + 复制按钮
│   ├── message-tool-bar/               # 复制 / 编辑 / 下载
│   ├── model-selector/                 # 模型切换
│   ├── files/                          # 文件列表项
│   ├── process/                        # Artifact 浮窗产物面板 + 人工决策节点
│   ├── settings/                       # ⭐ 设置弹窗（5 个页面）
│   │   ├── account-settings-page.tsx   # 账户设置
│   │   ├── mcp-servers-section.tsx     # MCP 服务器管理
│   │   ├── memory-settings-page.tsx    # 记忆/知识库管理
│   │   ├── skill-settings-page.tsx     # 技能管理
│   │   └── tools-settings-page.tsx     # 工具查看
│   └── sider/                          # 左侧会话侧边栏
│
├── deerflow-harness/                   # ⭐ 多智能体编排核心
│   ├── client.ts                       # DeerFlowClient：Agent 缓存 + LangGraph 流式调用
│   ├── agents/                         # Agent 工厂、中间件、记忆、特性装配
│   │   ├── factory.ts                  # createBaseAgent + assembleFromFeatures
│   │   ├── features.ts                 # RuntimeFeatures + Next/Prev 装饰器
│   │   ├── thread-state.ts             # ThreadStateAnnotation 定义
│   │   ├── lead-agent/prompt.ts        # lead agent 系统提示词
│   │   ├── middlewares/                # 14 种中间件实现（含 tool-call-integrity 子目录）
│   │   └── memory/                     # MemoryUpdater（LLM 驱动）+ 存储与队列
│   ├── extensions/                     # 统一扩展配置存储（extensions_config.json）
│   ├── mcp/                            # MCP 客户端（MultiServerMCPClient 封装）
│   ├── skills/                         # Skill 加载器（frontmatter 解析 + prompt 注入）
│   ├── subagents/                      # SubagentExecutor、注册表、schema、general-purpose 内置
│   ├── runtime/                        # ThreadService、StreamBridge、SSE、Checkpointer
│   │   ├── service.ts                  # ThreadService（fire-and-forget 提交 + 状态收敛）
│   │   ├── stream-bridge/              # 进程内事件总线 + ThreadChannel（缓冲回放）
│   │   ├── sse/                        # ClientAgentEvent 白名单 + 内→外过滤
│   │   ├── checkpointer/               # PostgreSQL checkpoint 工厂
│   │   └── context.ts                  # AsyncLocalStorage 上下文传播
│   ├── persistence/                    # ThreadMetaStore + RunStore（PostgreSQL）
│   ├── tools/builtins/                 # 内置工具（task、search_web、clarification）
│   ├── models/                         # 模型预设（MODEL_PRESETS）
│   ├── auth/                           # 认证模块
│   ├── config/                         # 应用配置
│   ├── sandbox/                        # 安全沙箱（路径校验、文件操作锁、异常隔离）
│   │   ├── tools.ts                    # 沙箱内置工具集（读/写/搜索/list 等）
│   │   ├── search.ts                   # 沙箱内搜索
│   │   ├── security.ts                 # 安全策略
│   │   ├── file-operation-lock.ts      # 并发文件操作锁
│   │   ├── path-utils.ts               # 路径安全处理
│   │   ├── exceptions.ts               # 异常定义
│   │   └── local/                      # 本地文件系统沙箱实现
│   └── types/                          # AgentEvent 等共享类型
│
├── runtime/                            # 前端运行时（SSE 解析、EventBus、Context）
│   ├── client/                         # sse-frame-parser、event-bus
│   ├── context/                        # AgentEventContext + hooks
│   └── protocol/                       # ClientAgentEvent re-export（前后端共享协议）
│
├── store/                              # Zustand 切片
│   ├── index.ts                        # 统一导出
│   ├── chat-session-store.ts           # 聊天会话 / 消息 / 流式状态
│   ├── file-upload-store.ts            # 文件上传
│   ├── modelStore.ts                   # 模型选择
│   └── auth-store.ts                   # 用户认证状态
│
├── lib/                                # 基础设施
│   ├── db/                             # PostgreSQL 连接桩
│   ├── cache/                          # Redis 客户端
│   ├── storage/                        # MinIO 客户端
│   └── file-parser.ts                  # PDF / Word 解析
│
├── hooks/                              # 自定义 React hooks
│   ├── use-auto-scroll-to-bottom.ts    # 自动滚动到底部
│   ├── use-copy.ts                     # 一键复制
│   ├── use-disclosure.ts               # 弹窗开关
│   ├── use-file-upload.ts              # 文件上传 hook
│   ├── use-outside-click.ts            # 点击外部关闭
│   └── use-textarea-auto-height.ts     # 文本域自适应高度
│
├── utils/
│   ├── auth/                           # 认证相关工具
│   ├── chat/                           # 流处理、parts collector / reducer、最终消息提取
│   ├── common/                         # message-content 等通用工具
│   ├── files/                          # 文件相关工具
│   └── request/                        # API 请求封装
├── types/                              # 全局类型
├── config/models.ts                    # 模型配置
├── middleware.ts                       # Next.js 中间件（鉴权守卫等）
└── global.d.ts                         # 全局类型声明

docker-compose.yaml                     # PostgreSQL + Redis + MinIO 一键启动
extensions_config.example.json          # MCP/Skills 扩展配置模板
CLAUDE.md                               # 架构与协作指引（详细版）
project.md                              # AI 协作代码规范

benchmarks/                             # 基准测试与评估框架
├── run.ts                              # 测试运行脚本
├── agent-wrapper.ts                    # Agent 包装器
├── config.ts                           # 测试配置
├── evaluators/                         # 评估器（质量打分）
├── datasets/research-qa.ts             # 研究 QA 数据集
└── results/                            # 评估结果持久化

docs/                                   # 设计文档
├── deerflow-alignment-plan.md          # DeerFlow 架构对齐计划
└── sandbox-implementation.md           # 沙箱实现设计文档

skills/                                 # 内置技能定义（7 种）
├── deep-research/SKILL.md              # 深度研究（核心技能）
├── consulting-analysis/SKILL.md        # 咨询分析
├── code-documentation/SKILL.md         # 代码文档生成
├── academic-paper-review/SKILL.md      # 学术论文评审
├── newsletter-generation/SKILL.md      # 新闻稿生成
├── frontend-design/SKILL.md            # 前端设计
└── web-design-guidelines/SKILL.md      # Web 设计指南
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

从模板复制并填写：

```bash
cp .env.example .env
```

`.env` 关键配置项：

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

# DeepSeek
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1

# Moonshot (Kimi)
MOONSHOT_API_KEY=your-moonshot-api-key
MOONSHOT_BASE_URL=https://api.moonshot.cn/v1

# === 检索 ===
TAVILY_API_KEY=your-tavily-api-key

# === PostgreSQL ===
DATABASE_URL=postgresql://yezi:fupingyezi123@localhost:5432/DeepResearch

# === Redis ===
REDIS_URL=redis://localhost:6379

# === MinIO ===
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=yezi
MINIO_SECRET_KEY=fupingyezi123
MINIO_BUCKET=chat-files

# === JWT 鉴权 ===
AUTH_JWT_SECRET=please_change_this_to_a_long_random_secret
AUTH_TOKEN_EXPIRY_DAYS=7
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

| 路由                                          | 方法         | 说明                                              |
| --------------------------------------------- | ------------ | ------------------------------------------------- |
| `/api/v3/chat/[threadId]`                     | POST         | ⭐ 主聊天入口，SSE 流。响应头 `X-Run-Id` 立即可读 |
| `/api/threads`                                | POST/GET     | 创建线程；分页列出（`?limit=&offset=&status=`）   |
| `/api/threads/[threadId]`                     | GET/DELETE   | 获取详情（可附带 checkpoint）/ 删除               |
| `/api/threads/[threadId]/runs`                | GET          | 列出线程下的 run                                  |
| `/api/threads/[threadId]/runs/[runId]/stream` | GET          | SSE 流回放                                        |
| `/api/conversations/*`                        | GET/POST     | 获取所有会话 / 历史消息 / 更新会话                |
| `/api/files/upload`                           | POST         | multipart 上传，存 MinIO 并解析内容               |
| `/api/files/delete`                           | DELETE       | 从 MinIO 删除                                     |
| `/api/memory`                                 | GET          | 查询记忆数据                                      |
| `/api/memory/facts`                           | GET/POST     | 记忆事实列表 / 新建                               |
| `/api/memory/facts/[id]`                      | PATCH/DELETE | 更新 / 删除记忆事实                               |
| `/api/mcp`                                    | GET/POST     | MCP 服务器列表 / 新建                             |
| `/api/mcp/[name]`                             | PATCH/DELETE | 修改 / 删除 MCP 服务器 + 启停切换                 |
| `/api/skills`                                 | GET/POST     | 技能列表 / 新建自定义 skill                       |
| `/api/skills/[name]`                          | PATCH        | 技能启用 / 禁用切换                               |
| `/api/tools`                                  | GET          | 当前已绑定工具列表                                |
| `/api/auth/register`                          | POST         | 用户注册                                          |
| `/api/auth/login`                             | POST         | 用户登录（返回 JWT）                              |
| `/api/auth/logout`                            | POST         | 登出                                              |
| `/api/auth/me`                                | GET          | 当前用户信息                                      |
| `/api/auth/change-password`                   | POST         | 修改密码                                          |
| `/api/auth/initialize`                        | POST         | 初始化管理员账户                                  |
| `/api/auth/setup-status`                      | GET          | 查询初始化状态                                    |
| `/api/auth/oauth/[provider]`                  | GET          | OAuth 第三方登录回调                              |

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

**SSE 客户端事件白名单（10 种）：**

`start` / `stream_chunk` / `tool_call` / `tool_result` / `task_progress` / `human_interrupt` / `error` / `end` / `heartbeat`

协议定义：`src/deerflow-harness/runtime/sse/client-event.ts`，前端通过 `src/runtime/protocol/client-event.ts` re-export 复用。

## 🧩 架构要点

```
前端（React/Next.js + Zustand + EventBus + 设置管理）
        │ HTTP + SSE
        ▼
API Routes（/api/v3/chat/[threadId] 等）
        │
        ▼
ThreadService（fire-and-forget 提交 Run，立即返回 run_id）
   │ ├── DeerFlowClient（Agent 缓存 + LangGraph 流式调用 + MCP/Skill 工具加载）
   │ │      └── createBaseAgent + 中间件管线（最多 14 层）
   │ │             ├── 工具：task / search_web / clarification / ...
   │ │             │         └── SubagentExecutor（父子共用 checkpoint）
   │ │             └── Sandbox（路径安全校验 + 文件操作锁 + 异常隔离）
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
- 中间件组装顺序与 `RuntimeFeatures` 开关（14 层中间件 + Tool Call 完整性子规则）
- Memory LLM 更新流程（含显式 `callbacks: []` 切断回调链的关键约束）
- ThreadMetaStore / RunStore 的 PG schema
- MCP 客户端连接与工具加载缓存策略
- Skill frontmatter 解析与 prompt 注入机制（7 种内置技能）
- 扩展统一配置（extensions_config.json）的读写与校验
- 沙箱安全策略、路径校验与文件操作锁机制

沙箱实现细节见 [`docs/sandbox-implementation.md`](./docs/sandbox-implementation.md)。
架构对齐计划见 [`docs/deerflow-alignment-plan.md`](./docs/deerflow-alignment-plan.md)。

## 📖 使用指南

### 对话

直接在输入框发送消息即可。lead-agent 会自主判断：

- **简单问题** → 直接回答，可能不调用任何工具
- **需要联网** → 自动调用 `search_web`
- **复杂研究** → 通过 `task("general-purpose", ...)` 启动一个或多个 subagent 并行检索，最终汇总报告

研究产出的完整报告自动收进右侧 **Artifact 浮窗面板**，气泡内仅保留入口卡片。

### 用户认证

系统内置用户注册/登录功能，使用 JWT 进行鉴权。首次部署时可通过 `/api/auth/initialize` 初始化管理员账户。支持 OAuth 第三方登录（按需配置 provider）。

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

每轮对话由 `MemoryUpdater` 通过 LLM 提取并增量更新（含 JSON 修复、上传内容清洗、置信度过滤、casefold 去重）。也可通过设置界面手动管理记忆事实。

### MCP 扩展

在设置「工具」页面中管理 MCP 服务器：

- 添加 stdio 或 HTTP 类型的 MCP server 配置
- 启用/禁用已注册的服务器
- 启用的 server 的工具自动加载到 Agent 工具集中
- 支持 `$VAR` 环境变量引用和按签名缓存连接

### Skill 技能

在设置「技能」页面中管理 Skills：

- 公共技能来自 `skills/public/` 目录，自定义技能存放在 `skills/custom/`
- 每个 skill 由一个 `SKILL.md` 文件定义（含 YAML frontmatter 元信息）
- 启用后其正文内容注入 lead-agent 系统提示
- 默认 opt-in（关闭），启用会产生额外 token 消耗

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
- `DEERFLOW_EXTENSIONS_CONFIG_PATH` —— 扩展配置文件路径（默认 `{cwd}/extensions_config.json`）

## 📊 基准测试

项目内置评估框架（`benchmarks/`），用于对 Agent 研究质量进行自动化打分：

```bash
# 运行基准测试
cd benchmarks && npx tsx run.ts

# 或从项目根目录（需先配置 benchmarks/.env.local）
npx tsx benchmarks/run.ts
```

测试流程：

1. 从 `datasets/research-qa.ts` 加载研究 QA 数据集
2. 通过 `agent-wrapper.ts` 包装 Agent 调用
3. `evaluators/` 对输出进行质量打分
4. 结果持久化到 `results/latest.json` / `.jsonl`

详见 [`benchmarks/README.md`](./benchmarks/README.md)。

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
5. 项目目前无单元测试（已内置 `benchmarks/` 评估框架，覆盖研究 QA 场景）

## 📝 License

MIT
