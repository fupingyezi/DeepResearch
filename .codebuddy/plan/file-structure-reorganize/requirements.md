# 需求文档：项目文件组织重构

## 引言

本项目（mini-DeepResearch）是一个基于 Next.js 14 + LangChain 构建的智能聊天应用，包含前端 UI、后端 API 路由、Agent 智能体逻辑、基础设施层等多个模块。随着功能迭代（如 v2 事件驱动架构、Harness 子代理系统等），当前文件组织出现了以下问题：

1. **Agent 业务逻辑误放在 `app/` 路由目录下**：`src/app/agents/` 包含大量非路由的业务逻辑代码，违反了 Next.js App Router 的目录约定
2. **存在空目录**：`src/app/agents/core/` 和 `src/app/agents/interfaces/` 为空目录，造成困惑
3. **废弃代码未清理**：`src/types/transform/stream.ts` 已标记 `@deprecated`，`src/utils/index.ts` 导出全部被注释
8. **存在分隔符注释**：部分文件中使用了 `// ---- xxx ----` 等分隔符风格的注释，影响代码整洁度
4. **前后端代码分层不清晰**：前端工具函数（`utils/chat/`、`utils/hooks/`）与后端逻辑缺乏明确的目录边界
5. **`lib/` 与 `utils/` 职责重叠**：`lib/` 放基础设施，`utils/` 放业务工具，但命名不够直观
6. **API 路由版本混乱**：同时存在 `v1/`、`v2/`、`basic_agents/`、`search_agents/` 等多种组织方式
7. **README 项目结构描述过时**：与实际目录结构不一致

本次重构的目标是：在不改变任何业务逻辑的前提下，通过移动文件、清理废弃代码、统一目录命名，使项目结构清晰、分层明确、易于维护。

## 需求

### 需求 1：将 Agent 业务逻辑从 `app/` 目录中迁出

**用户故事：** 作为一名开发者，我希望 Agent 相关的业务逻辑代码不再放在 Next.js 的 `app/` 路由目录下，以便遵循 Next.js App Router 的目录约定，避免路由解析冲突和认知混乱。

#### 验收标准

1. WHEN 重构完成 THEN 系统 SHALL 将 `src/app/agents/` 下的所有非路由业务逻辑代码迁移到 `src/agents/` 目录（与 `src/app/` 同级）
2. WHEN Agent 代码迁移后 THEN 系统 SHALL 更新所有引用了旧路径 `@/app/agents/` 的 import 语句为新路径 `@/agents/`
3. WHEN 迁移完成后 THEN `src/app/` 目录 SHALL 仅包含 Next.js 路由相关文件（`page.tsx`、`layout.tsx`、`api/`、`globals.css`、`favicon.ico`）
4. WHEN 迁移完成后 THEN 所有 Agent 功能（Chat、Search、DeepResearch）SHALL 正常工作，无功能回归

### 需求 2：清理空目录和废弃代码

**用户故事：** 作为一名开发者，我希望项目中不存在空目录和已废弃的代码文件，以便减少认知负担，保持代码库整洁。

#### 验收标准

1. WHEN 清理完成 THEN 系统 SHALL 删除空目录 `src/app/agents/core/`（迁移后为 `src/agents/core/`）
2. WHEN 清理完成 THEN 系统 SHALL 删除空目录 `src/app/agents/interfaces/`（迁移后为 `src/agents/interfaces/`）
3. IF `src/types/transform/stream.ts` 中的 deprecated 类型已无任何文件引用 THEN 系统 SHALL 删除该文件及 `transform/` 目录
4. IF `src/types/transform/stream.ts` 中的 deprecated 类型仍有文件引用 THEN 系统 SHALL 保留该文件并在文件头部添加注释说明哪些文件仍在引用，以便后续迁移
5. WHEN 清理完成 THEN 系统 SHALL 修复 `src/utils/index.ts` 中被注释掉的导出，恢复有效导出或删除无用文件
6. WHEN 清理完成 THEN 系统 SHALL 删除项目中所有分隔符风格的注释（如 `// ---- xxx ----`、`// ==== xxx ====`、`// **** xxx ****` 等），已知存在于 `src/app/agents/eventStream/EventStreamAdapter.ts`（迁移后路径为 `src/agents/eventStream/EventStreamAdapter.ts`）

### 需求 3：统一 API 路由组织方式

**用户故事：** 作为一名开发者，我希望 API 路由有统一的组织方式和清晰的版本管理，以便快速定位和维护接口代码。

#### 验收标准

1. WHEN 重构完成 THEN `src/app/api/chat/` 下的路由 SHALL 采用统一的组织方式：保留 `v2/` 作为当前主版本路由，`v1/` 作为兼容路由
2. IF `basic_agents/` 和 `search_agents/` 路由属于 v1 版本 THEN 系统 SHALL 将它们移入 `v1/` 目录下，或添加清晰的注释说明其版本归属
3. WHEN 路由重组后 THEN 所有前端调用的 API 路径 SHALL 保持不变或同步更新，确保前后端通信正常
4. WHEN 路由重组后 THEN `src/app/api/utils/` 中的工具函数 SHALL 迁移到 `src/lib/` 或 `src/agents/` 中更合适的位置，因为 `api/utils/` 不是有效的 API 路由

### 需求 4：明确前后端代码分层

**用户故事：** 作为一名开发者，我希望前端代码和后端代码有清晰的目录边界，以便在开发时快速判断代码的运行环境和职责。

#### 验收标准

1. WHEN 重构完成 THEN 前端专用代码（React 组件、Hooks、前端工具函数、状态管理）SHALL 集中在以下目录中：
   - `src/components/` — UI 组件
   - `src/store/` — 状态管理
   - `src/utils/hooks/` — 自定义 Hooks
   - `src/utils/chat/` — 前端聊天工具函数
   - `src/utils/files/` — 前端文件处理工具
   - `src/utils/request/` — API 请求封装
2. WHEN 重构完成 THEN 后端专用代码 SHALL 集中在以下目录中：
   - `src/agents/` — Agent 智能体逻辑
   - `src/lib/` — 基础设施（数据库、缓存、存储、LLM）
   - `src/app/api/` — API 路由处理器
3. WHEN 重构完成 THEN 共享代码（类型定义等）SHALL 保留在 `src/types/` 目录中
4. WHEN 前后端分层完成 THEN 系统 SHALL 确保没有前端代码直接 import 后端模块（如数据库连接），也没有后端代码直接 import 前端模块（如 React Hooks）

### 需求 5：更新项目文档和导出索引

**用户故事：** 作为一名开发者，我希望 README 中的项目结构描述与实际目录结构一致，且各模块的 `index.ts` 导出文件准确反映模块内容，以便新成员快速上手。

#### 验收标准

1. WHEN 所有文件迁移完成 THEN 系统 SHALL 更新 `README.md` 中的项目结构树，使其与实际目录结构完全一致
2. WHEN 所有文件迁移完成 THEN 系统 SHALL 更新所有 `index.ts` 桶文件（barrel files），确保导出路径正确
3. WHEN 文档更新完成 THEN README 中 SHALL 不再提及已删除的目录（如 `pages/`）
4. WHEN 重构完成 THEN 系统 SHALL 确保 TypeScript 编译（`pnpm build`）无错误
5. WHEN 重构完成 THEN 系统 SHALL 确保开发服务器（`pnpm dev`）可正常启动并运行

## 约束与注意事项

- **不改变任何业务逻辑**：本次重构仅涉及文件移动、路径更新、废弃代码清理，不修改任何功能实现
- **保持 Git 历史可追溯**：尽量使用 `git mv` 进行文件移动，保留文件历史
- **渐进式迁移**：如果某些 deprecated 代码仍有引用，暂时保留并标注，不强制一次性清除
- **路径别名**：项目使用 `@/*` 映射到 `./src/*`，迁移后所有 import 路径需基于此别名更新
- **不使用分隔符注释**：重构过程中不得新增任何分隔符风格的注释（如 `// ----`、`// ====`、`// ****` 等），并清理现有的分隔符注释
