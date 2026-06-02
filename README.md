# mini-DeepResearch

一个基于 **Next.js + LangGraph** 实现的多智能体深度研究助手。
参考 DeerFlow 2.0 架构，前端提供 DeerFlow 风格的浅色精致 UI（聊天 + 思考时间线 + Artifact 浮窗产物面板），后端通过自研 `deerflow-harness` 框架编排 Planner / Researcher / Reporter / Coder 等子智能体协同完成复杂研究任务。

## ✨ 主要特性

- 🤖 **多智能体协同（DeerFlow Harness）**：Planner 拆解任务 → Researcher 并发检索 → Reporter 汇总报告 → Coder 处理结构化数据，全流程通过 LangGraph + checkpoint 持久化。
- 🧠 **可视化思考时间线**：聊天气泡内实时展示 reasoning / tool_call / subagent_task 折叠卡片，支持思考过程、工具入参、搜索结果、子任务摘要分级查看。
- 📄 **Artifact 浮窗产物面板**：研究报告自动收进右侧浮窗卡片（DeerFlow 风格的"分隔区+悬浮卡片"层次），气泡内仅保留入口与任务总结，避免长报告淹没对话。
- 🔍 **多模式对话**：basic 普通聊天 / search 联网搜索 / deep_research 深度研究，统一走 `/api/chat/v2`。
- 📁 **多格式文件上传**：PDF、Word、图片等，自动入 MinIO 并参与上下文。
- 📝 **完整 Markdown 渲染**：GFM、KaTeX 数学公式、代码高亮、长 URL/表格安全换行。
- 🎨 **浅色精致 UI**：青绿主色 + 卡片化布局 + 细滚动条 + 渐变按钮，整体观感对齐 DeerFlow 2.0。
- 💾 **会话持久化**：PostgreSQL 存对话与 LangGraph checkpoint，Redis 做缓存与状态。

## 🛠️ 技术栈

### 前端

- **Next.js 14**（App Router）+ **React 18** + **TypeScript**
- **Tailwind CSS v4**（`@theme inline` token 主题）
- **Ant Design** + **Lucide / @ant-design/icons**
- **Zustand**（轻量状态管理，按 store 分片）
- **react-markdown** + **remark-gfm/math** + **rehype-katex** + **react-syntax-highlighter**

### Agent / AI

- **LangChain 1.x** + **LangGraph 1.x**（多智能体编排 + checkpoint）
- **@langchain/langgraph-checkpoint-postgres**（PostgreSQL checkpoint）
- **@langchain/openai**（OpenAI 兼容协议，支持 OpenAI / 千问 / 星火等）
- **Tavily**（联网搜索）
- 自研 **deerflow-harness**：Planner / Researcher / Reporter / Coder 子智能体框架

### 存储

- **PostgreSQL**：会话、消息、checkpoint
- **Redis**：缓存与会话状态
- **MinIO**：上传文件对象存储

## 📁 项目结构

```
├── src/
│   ├── app/                       # Next.js App Router
│   │   ├── api/
│   │   │   ├── chat/v2/           # 统一聊天入口（basic / search / deep_research）
│   │   │   ├── conversations/     # 会话/消息/历史 API
│   │   │   └── files/             # 文件上传 / 删除 API
│   │   ├── globals.css            # 全局样式 + 浅色主题 token + prose/滚动条微调
│   │   ├── layout.tsx             # 根布局（Sider + 主体）
│   │   └── page.tsx               # 主页（聊天区 + Artifact 浮窗面板）
│   │
│   ├── components/                # UI 组件（小写-横线命名）
│   │   ├── chat-window/           # 聊天容器、消息列表、气泡、思考时间线、输入框
│   │   ├── markdown/              # CustomMarkdown（prose 排版 + 代码块 + 数学公式）
│   │   ├── message-tool-bar/      # 消息悬浮工具条（复制/编辑/下载）
│   │   ├── model-selector/        # 模型切换
│   │   ├── files/                 # 文件上传/预览
│   │   ├── process/               # ArtifactPanel 浮窗产物面板
│   │   └── sider/                 # 左侧会话侧边栏
│   │
│   ├── deerflow-harness/          # ⭐ 多智能体编排核心
│   │   ├── agents/                # Planner / Researcher / Reporter / Coder 等
│   │   ├── subagents/             # 子代理调度与上下文隔离
│   │   ├── runtime/               # 运行时（事件流、状态机、中断恢复）
│   │   ├── tools/                 # 工具定义（搜索、抓取、代码执行等）
│   │   ├── persistence/           # checkpoint 持久化
│   │   ├── models/                # 模型适配
│   │   ├── mcp/                   # MCP 协议接入
│   │   ├── sandbox/ skills/ config/
│   │   ├── types/                 # 共享类型（subagent / event / artifact）
│   │   ├── client.ts              # Harness 入口
│   │   └── index.ts
│   │
│   ├── runtime/                   # 前端运行时（事件解析、流式状态机）
│   ├── store/                     # Zustand 切片（会话、消息、文件、模型、Artifact 面板）
│   ├── lib/                       # 基础设施（db / cache / storage / llm / stream）
│   ├── types/                     # 全局类型
│   ├── utils/
│   │   ├── chat/                  # 流处理、最终消息提取、消息归一化
│   │   ├── files/                 # 文件解析
│   │   ├── hooks/                 # 自定义 React hooks
│   │   └── request/               # API 请求封装
│   └── config/                    # 应用配置
│
├── public/                        # 静态资源（svg 图标）
├── docker-compose.yaml            # PostgreSQL + Redis + MinIO 一键启动
├── next.config.js / eslint.config.mjs / postcss.config.mjs
├── package.json
└── tsconfig.json
```

## 🚀 快速开始

### 环境要求

- **Node.js 18+**
- **pnpm**（推荐）
- **Docker & Docker Compose**（启动 PostgreSQL / Redis / MinIO）

### 安装依赖

```bash
pnpm install
```

### 配置环境变量

在项目根目录创建 `.env`：

```env
# === 模型 API（任选其一或多个）===
# OpenAI
OPENAI_API_KEY=your-openai-api-key
OPENAI_API_BASE=https://api.openai.com/v1

# 阿里千问（OpenAI 兼容）
OPENAI_QWEN_API_KEY=your-qwen-api-key
OPENAI_QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1

# 讯飞星火（OpenAI 兼容）
OPENAI_SPARK_API_KEY=your-spark-api-key
OPENAI_SPARK_BASE_URL=https://spark-api-open.xf-yun.com/v1

# === 检索 ===
TAVILY_API_KEY=your-tavily-api-key

# === PostgreSQL ===
DATABASE_URL=postgresql://yezi:fupingyezi123@localhost:5432/mini-DeepResearch

# === Redis ===
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_URL=redis://localhost:6379

# === MinIO ===
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=yezi
MINIO_SECRET_KEY=fupingyezi123
MINIO_BUCKET=chat-files
```

> 注意：`.env` 与 `docker-compose.yaml` 中的账密、端口需保持一致。如需切换默认模型，请到 `src/deerflow-harness/models` 与 `src/lib/llm` 对应处调整。

### 启动基础设施

```bash
docker-compose up -d
```

会启动 PostgreSQL / Redis / MinIO 三个服务。

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

## 📖 使用指南

### 基础聊天 / 联网搜索 / 深度研究

- 顶部模型选择器切换模型；输入框右侧的工具按钮切换 **basic / search / deep_research** 模式。
- 深度研究模式会触发 Planner → Researcher → Reporter 全流程，气泡内可实时看到子任务规划与每一步检索的搜索结果。
- 研究产出的完整报告自动收进右侧 **Artifact 浮窗面板**，气泡内只保留入口卡片 + 任务总结，点击入口即可查看完整 Markdown 报告。

### 思考时间线

每条 AI 回复内嵌一个折叠时间线卡片：

- 🟡 **思考**（reasoning）—— 模型规划文本
- 🔵 **工具调用**（tool_call）—— 入参 / 错误 / 结果，搜索结果列表化展示
- 🟣 **子任务**（subagent_task）—— 子代理描述、步骤数、结构化摘要

所有项默认折叠，可逐项展开排查；JSON 与搜索结果自带最大高度与细滚动条，不会撑破气泡。

### 文件上传

输入框左侧的回形针图标支持上传 PDF、Word、图片等，文件解析后参与本轮对话上下文。

## 🎨 UI 设计要点（DeerFlow 2.0 风格）

- **浅色基调** + **青绿主色**（teal-500/600）+ 灰阶层次。
- **三栏弹性布局**：左侧固定 220px session 栏 / 中间限宽 880px 居中聊天区 / 右侧 440~680px 浮窗 Artifact 面板。
- **浮窗卡片**：Artifact 面板外层是浅灰底+左分隔线的"分隔区"，内层是白底圆角双层阴影的"卡片"，与 DeerFlow 2.0 一致的层次感。
- **细节**：自定义 `scrollbar-slim` 滚动条、prose 长串 break-words 兜底、代码块限宽、聚焦态青绿描边。

## 🛠️ 开发流程

```bash
# 代码检查
pnpm lint

# 格式化
pnpm format
pnpm format:check

# 构建
pnpm build
```

## 📝 License

MIT
