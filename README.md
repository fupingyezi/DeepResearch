# LangChain Next.js Application

这是一个基于 Next.js 14 和 LangChain 构建的智能聊天应用，提供了 AI 交互功能和现代化的用户界面。

## ✨ 主要功能特性

- 🤖 **智能聊天**：基于 LangChain 实现普通聊天、网络搜索和深度研究
- 📁 **文件上传**：支持多种格式文件上传和处理
- 📊 **深度研究流程**：集成 Tavily 搜索和 LangGraph 实现复杂研究任务
- 📱 **响应式设计**：使用 Ant Design 构建的现代化 UI
- 📝 **Markdown 支持**：完整的 Markdown 渲染，包括数学公式
- 💾 **状态管理**：使用 Zustand 进行高效的状态管理
- 🔧 **可扩展架构**：模块化设计，便于功能扩展

## 🛠️ 技术栈

### 前端

- **Next.js 14** - React 框架，支持 App Router
- **TypeScript** - 类型安全的 JavaScript
- **Ant Design** - 企业级 UI 组件库
- **Zustand** - 轻量级状态管理
- **React Markdown** - Markdown 渲染
- **KaTeX** - 数学公式渲染

### 后端/AI

- **LangChain** - AI 应用开发框架
- **LangGraph** - 构建智能代理和工作流
- **OpenAI API** - 强大的语言模型
- **Tavily** - 智能搜索服务

### 数据库/存储

- **PostgreSQL** - 关系型数据库，用于存储对话历史
- **Redis** - 缓存和会话管理
- **Minio** - 文件存储管理

## 📁 项目结构

```
├── src/
│   ├── agents/             # Agent 智能体业务逻辑
│   │   ├── eventStream/    # 事件流适配器（LangChain → AgentEvent）
│   │   ├── harness/        # Harness 子代理系统
│   │   │   ├── hooks/      # Harness 钩子实现
│   │   │   └── subagents/  # 子代理配置
│   │   ├── modules/        # Agent 组合模块（事件发射器、流处理器）
│   │   └── tools/          # Agent 工具定义
│   ├── app/                # Next.js App Router
│   │   ├── api/            # API 路由
│   │   │   ├── chat/
│   │   │   │   └── v2/     # 统一路由（支持 basic/search/deep_research）
│   │   │   ├── conversations/  # 会话管理 API
│   │   │   └── files/      # 文件上传/删除 API
│   │   ├── layout.tsx      # 根布局
│   │   └── page.tsx        # 主页
│   ├── components/         # UI 组件
│   │   ├── ChatWindow/     # 聊天窗口组件
│   │   ├── Files/          # 文件处理组件
│   │   ├── Markdown/       # Markdown 渲染组件
│   │   ├── MessageToolBar/ # 消息工具栏组件
│   │   ├── Process/        # 深度研究流程组件
│   │   └── Sider/          # 侧边栏组件
│   ├── lib/                # 基础设施层
│   │   ├── cache/          # 缓存配置
│   │   ├── db/             # 数据库配置
│   │   ├── llm/            # LLM API 构建
│   │   ├── storage/        # 文件存储（MinIO）
│   │   └── stream/         # 流处理（AgentEvent SSE 构建）
│   ├── store/              # Zustand 状态管理
│   ├── types/              # TypeScript 类型定义
│   └── utils/              # 前端工具函数
│       ├── chat/           # 聊天相关工具
│       ├── files/          # 文件处理工具
│       ├── hooks/          # 自定义 React Hooks
│       └── request/        # API 请求封装
├── public/                 # 静态资源
├── docker-compose.yaml     # Docker 配置
├── next.config.js          # Next.js 配置
├── package.json            # 项目依赖
└── tsconfig.json           # TypeScript 配置
```

## 🚀 快速开始

### 环境要求

- Node.js 18+
- PostgreSQL 8+
- Redis 5+
- Minio 8+

### 安装依赖

```bash
# 使用 npm
npm install

# 使用 pnpm
pnpm install
```

### 配置环境变量

创建 `.env` 文件并配置以下环境变量：

```env
# OpenAI API 配置
OPENAI_API_KEY=your-openai-api-key
OPENAI_API_BASE=https://api.openai.com/v1

# 阿里千问API
OPENAI_QWEN_API_KEY=your-qwen-api-key
OPENAI_QWEN_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"

# 星火大模型API
OPENAI_SPARK_API_KEY=your-spark-api-key
OPENAI_SPARK_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"

# PostgreSQL 配置
DATABASE_URL="postgresql://yezi:fupingyezi123@localhost:5432/mini-DeepResearch"

# Redis 配置
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_URL="redis://localhost:6379"

# Minio 配置
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=yezi
MINIO_SECRET_KEY=fupingyezi123
MINIO_BUCKET=chat-files

# Tavily API 配置
TAVILY_API_KEY=your-tavily-api-key
```

注意：

1. 本项目目前使用千问，如果需要使用其他模型，请到 agent 对应处修改代码。
2. 环境配置和 docker 配置是相对应的，如修改请同时修改两处。

### 使用 Docker

使用 Docker Compose 启动数据库服务：

```bash
docker-compose up -d
```

### 启动开发服务器

```bash
npm run dev
# or
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000) 查看应用。

## 📖 使用指南

### 基础聊天

1. 在聊天输入框中输入问题或消息
2. 点击发送按钮或按 Enter 键发送
3. 等待 AI 回复
4. 可以继续与 AI 进行多轮对话

### 深度研究

1. 点击侧边栏的深度研究按钮
2. 输入研究主题
3. AI 将自动进行搜索和分析
4. 查看研究结果和过程

### 文件上传

1. 点击聊天窗口的文件上传按钮
2. 选择要上传的文件
3. 文件将被自动处理和分析
4. 可以基于文件内容进行提问

## 🛠️ 开发流程

### 代码风格

使用 ESLint 进行代码检查：

```bash
pnpm run lint
```

### 构建生产版本

```bash
pnpm run build
```

### 启动生产服务器

```bash
pnpm start
```
