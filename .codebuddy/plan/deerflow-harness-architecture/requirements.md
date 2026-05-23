# 需求文档：deerflow-harness 架构重组

## 引言

当前 mini-DeepResearch 项目的 Agent 相关代码分散在多个目录中：
- `src/agents/harness/` — Agent 编排核心（AgentHarness、SubAgentDispatcher、Hooks 等）
- `src/lib/llm/` — Model Factory（factory.ts、classResolver.ts、patches.ts 等）
- `src/agents/tools/` — 工具定义（searchWebTool）
- `src/agents/modules/` — 事件发射器、流处理器

参照 DeerFlow 的模块化设计理念，本次重组的目标是将所有 Agent 运行时相关的代码统一组织到 `deerflow-harness` 包结构中，使其成为一个**独立可发布的 npm 包**，具备清晰的模块边界和统一的对外 API。

### 目标架构

```
deerflow-harness/（可发布包）
├── agents/       → Agent 编排核心（LeadAgent、SubAgent、Dispatcher、Registry）
├── tools/        → 统一工具注册与管理（BaseTool 接口、内置工具）
├── sandbox/      → 代码执行沙箱（未来扩展）
├── models/       → Model Factory + 配置 + 类解析器 + 补丁
├── mcp/          → MCP 协议适配器（未来扩展）
├── skills/       → 可复用的高级能力（搜索、总结等）
├── memory/       → 对话记忆/上下文管理（未来扩展）
├── middleware/   → Agent 中间件链（Hooks 演化）
└── config/       → 统一配置加载（模型配置、Agent 配置、工具配置）
```

### 当前架构问题

| 问题 | 描述 |
|------|------|
| 模块分散 | Agent 相关代码散落在 `src/agents/harness/`、`src/lib/llm/`、`src/agents/tools/` 等多处 |
| 边界不清 | Model Factory 放在 `lib/llm/` 下，但它是 harness 的核心依赖 |
| 不可独立发布 | 当前结构与 Next.js 应用耦合，无法作为独立包使用 |
| 缺少扩展模块 | 没有 sandbox、mcp、skills、memory 等模块的占位 |
| Hooks 命名不规范 | 当前的 Hooks 系统实质上是中间件模式，应重命名为 middleware |

---

## 需求

### 需求 1：包结构重组 — 创建 deerflow-harness 目录

**用户故事：** 作为一名开发者，我希望将所有 Agent 运行时相关代码组织到统一的 `deerflow-harness` 包目录中，以便未来可以独立发布为 npm 包。

#### 验收标准

1. WHEN 重组完成 THEN 项目中 SHALL 存在 `src/deerflow-harness/` 目录，包含以下子目录：
   - `agents/` — Agent 编排核心
   - `tools/` — 工具注册与管理
   - `sandbox/` — 代码执行沙箱（初始为空骨架）
   - `models/` — Model Factory
   - `mcp/` — MCP 适配器（初始为空骨架）
   - `skills/` — 高级能力（初始为空骨架）
   - `memory/` — 记忆管理（初始为空骨架）
   - `middleware/` — 中间件链
   - `config/` — 统一配置
2. WHEN 重组完成 THEN `deerflow-harness/` 目录 SHALL 有一个统一的 `index.ts` 入口文件，导出所有公开 API
3. IF 子模块当前无实际代码（如 sandbox、mcp、skills、memory） THEN 系统 SHALL 创建包含 `index.ts` 的空骨架目录，导出空对象或类型占位

### 需求 2：agents 模块 — 迁移 Agent 编排核心

**用户故事：** 作为一名开发者，我希望 Agent 编排核心（AgentHarness、SubAgentDispatcher、SubAgentRegistry、LeadAgentHarness）统一放在 `deerflow-harness/agents/` 下，以便清晰管理 Agent 生命周期。

#### 验收标准

1. WHEN 迁移完成 THEN `deerflow-harness/agents/` SHALL 包含以下文件：
   - `AgentHarness.ts` — Agent 基类
   - `LeadAgentHarness.ts` — Lead Agent 实现
   - `SubAgentDispatcher.ts` — Sub-agent 分发器
   - `SubAgentRegistry.ts` — Sub-agent 注册表
   - `types.ts` — Agent 相关类型定义
   - `index.ts` — 模块导出
2. WHEN 迁移完成 THEN 原 `src/agents/harness/` 目录 SHALL 被删除
3. WHEN Agent 代码迁移后 THEN 所有内部 import 路径 SHALL 更新为新的相对路径
4. IF 外部代码（如 API route）引用了 harness THEN 这些引用 SHALL 更新为从 `deerflow-harness` 导入

### 需求 3：models 模块 — 迁移 Model Factory

**用户故事：** 作为一名开发者，我希望 Model Factory 及其相关文件（配置、类解析器、补丁、环境变量解析）统一放在 `deerflow-harness/models/` 下，以便模型管理与 Agent 编排紧密集成。

#### 验收标准

1. WHEN 迁移完成 THEN `deerflow-harness/models/` SHALL 包含以下文件：
   - `factory.ts` — createChatModel 核心函数
   - `classResolver.ts` — 静态模块注册表 + 类解析
   - `patches.ts` — 补丁注册机制
   - `resolveEnv.ts` — 环境变量解析
   - `configLoader.ts` — 配置加载与验证
   - `models.config.ts` — 模型配置声明
   - `types.ts` — 模型相关类型
   - `index.ts` — 模块导出
2. WHEN 迁移完成 THEN 原 `src/lib/llm/` 目录 SHALL 被删除
3. WHEN 迁移完成 THEN `src/lib/index.ts` SHALL 更新为从 `deerflow-harness` re-export 模型相关 API

### 需求 4：tools 模块 — 统一工具注册

**用户故事：** 作为一名开发者，我希望所有工具定义和注册逻辑统一放在 `deerflow-harness/tools/` 下，以便实现工具的集中管理和按需加载。

#### 验收标准

1. WHEN 迁移完成 THEN `deerflow-harness/tools/` SHALL 包含：
   - `searchWebTool.ts` — 网页搜索工具
   - `index.ts` — 工具注册与导出
2. WHEN 迁移完成 THEN 原 `src/agents/tools/` 目录 SHALL 被删除
3. WHEN 工具被 Agent 使用时 THEN Agent SHALL 从 `deerflow-harness/tools` 导入工具

### 需求 5：middleware 模块 — Hooks 演化为中间件

**用户故事：** 作为一名开发者，我希望将当前的 Hooks 系统重命名为 middleware，使其语义更清晰，并为未来的 pre/post hook 扩展做好准备。

#### 验收标准

1. WHEN 迁移完成 THEN `deerflow-harness/middleware/` SHALL 包含：
   - `HooksManager.ts`（或重命名为 `MiddlewareManager.ts`）
   - `HumanReviewHook.ts`（或重命名为 `HumanReviewMiddleware.ts`）
   - `hooks.ts` — Hook 类型定义
   - `index.ts` — 模块导出
2. WHEN 迁移完成 THEN 原 `src/agents/harness/hooks/` 目录 SHALL 被删除
3. IF 重命名 Hook 为 Middleware THEN 所有相关类名、接口名、文件名 SHALL 同步更新

### 需求 6：config 模块 — 统一配置管理

**用户故事：** 作为一名开发者，我希望所有配置（模型配置、Sub-agent 配置）统一放在 `deerflow-harness/config/` 下，以便集中管理和验证。

#### 验收标准

1. WHEN 迁移完成 THEN `deerflow-harness/config/` SHALL 包含：
   - `models.config.ts` — 模型配置（从 models/ 引用或直接放置）
   - `subagents/` — Sub-agent 配置目录
     - `simpleAnalyser.config.ts`
     - `taskDecomposer.config.ts`
     - `taskHandler.config.ts`
     - `reportGenerator.config.ts`
     - `index.ts`
   - `index.ts` — 统一配置导出
2. WHEN 迁移完成 THEN 原 `src/agents/harness/subagents/` 目录 SHALL 被删除
3. WHEN 配置加载时 THEN 系统 SHALL 从 `deerflow-harness/config` 统一读取所有配置

### 需求 7：空骨架模块 — sandbox、mcp、skills、memory

**用户故事：** 作为一名开发者，我希望为未来扩展预留 sandbox、mcp、skills、memory 模块的目录结构，以便后续开发时有清晰的代码放置位置。

#### 验收标准

1. WHEN 重组完成 THEN 以下目录 SHALL 存在且包含 `index.ts` 骨架文件：
   - `deerflow-harness/sandbox/index.ts` — 导出空接口 `SandboxProvider`
   - `deerflow-harness/mcp/index.ts` — 导出空接口 `MCPAdapter`
   - `deerflow-harness/skills/index.ts` — 导出空接口 `Skill`
   - `deerflow-harness/memory/index.ts` — 导出空接口 `MemoryProvider`
2. IF 骨架模块被导入 THEN 系统 SHALL 不报错（类型正确，运行时为空实现）

### 需求 8：统一入口与路径别名

**用户故事：** 作为一名开发者，我希望通过统一的入口文件和路径别名访问 deerflow-harness 的所有功能，以便使用时简洁明了。

#### 验收标准

1. WHEN 重组完成 THEN `deerflow-harness/index.ts` SHALL 导出所有子模块的公开 API
2. WHEN 重组完成 THEN `tsconfig.json` 中 SHALL 配置路径别名 `@deerflow-harness/*` 指向 `src/deerflow-harness/*`
3. WHEN 外部代码需要使用 harness 功能时 THEN 开发者 SHALL 能通过 `import { createChatModel } from "@deerflow-harness/models"` 或 `import { AgentHarness } from "@deerflow-harness/agents"` 访问
4. IF 旧的 `@/lib` 路径被使用 THEN 系统 SHALL 通过 re-export 保持兼容（`src/lib/index.ts` 从 deerflow-harness re-export）

### 需求 9：外部调用方迁移

**用户故事：** 作为一名开发者，我希望所有引用旧路径的外部代码（API routes、AgentServer 等）都更新为新路径，以保持代码一致性。

#### 验收标准

1. WHEN 迁移完成 THEN `src/agents/ChatAgentServer.ts` SHALL 从 `@deerflow-harness/models` 导入 `createChatModel`
2. WHEN 迁移完成 THEN `src/agents/SearchAgentServer.ts` SHALL 从 `@deerflow-harness/models` 导入 `createChatModel`
3. WHEN 迁移完成 THEN `src/app/api/chat/v2/route.ts` SHALL 从 `@deerflow-harness/agents` 导入 harness 相关类
4. WHEN 迁移完成 THEN 项目中 SHALL 不存在对旧路径 `@/agents/harness` 或 `@/lib/llm` 的直接引用
5. IF `src/lib/index.ts` 保留 re-export THEN 该文件 SHALL 仅作为兼容层，内容为从 deerflow-harness 的 re-export
