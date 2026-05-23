# 实施计划：项目文件组织重构

- [ ] 1. 将 `src/app/agents/` 整体迁移到 `src/agents/`
  - 将 `src/app/agents/` 下所有文件和子目录（`AgentManager.ts`、`BaseAgentServer.ts`、`ChatAgentServer.ts`、`DeepResearchAgentServer.ts`、`SearchAgentServer.ts`、`index.ts`、`prompts.ts`、`eventStream/`、`harness/`、`modules/`、`tools/`）移动到 `src/agents/`
  - 迁移时排除空目录 `core/` 和 `interfaces/`，不将它们带入新目录
  - 检查 `src/app/agents/` 内部文件之间的相对路径 import，确认迁移后无需修改（因为内部相对关系不变）
  - _需求：1.1、2.1、2.2_

- [ ] 2. 更新所有引用 `@/app/agents` 的 import 路径为 `@/agents`
  - 修改 `src/app/api/chat/v2/route.ts` 中的 `from "@/app/agents"` → `from "@/agents"`
  - 修改 `src/app/api/chat/basic_agents/route.ts` 中的 `from "@/app/agents"` → `from "@/agents"`
  - 修改 `src/app/api/chat/search_agents/route.ts` 中的 `from "@/app/agents"` → `from "@/agents"`
  - 修改 `src/app/api/chat/v1/deep_research/route.ts` 中的 `from "@/app/agents"` → `from "@/agents"`
  - _需求：1.2_

- [ ] 3. 将 `src/app/api/utils/` 下的工具函数迁移到 `src/lib/`
  - 将 `createAgentEventSSEStream.ts` 移动到 `src/lib/stream/`（它属于后端 SSE 流处理，与 `lib/stream/` 职责一致）
  - 将 `createSSEStream.ts` 移动到 `src/lib/stream/`（同上，且已标记 `@deprecated`）
  - 将 `fileParser.ts` 移动到 `src/lib/`（后端文件解析工具）
  - 更新 `src/app/api/chat/v2/route.ts` 中 `createAgentEventSSEStream` 的 import 路径（当前为相对路径 `../../utils/createAgentEventSSEStream`）
  - 更新 `src/app/api/chat/basic_agents/route.ts` 中 `createSSEStream` 的 import 路径（当前为相对路径 `../../utils/createSSEStream`）
  - 更新 `src/app/api/chat/search_agents/route.ts` 中 `createSSEStream` 的 import 路径
  - 更新 `src/app/api/chat/v1/deep_research/route.ts` 中 `createSSEStream` 的 import 路径（当前为 `@/app/api/utils/createSSEStream`）
  - 更新 `src/app/api/files/upload/route.ts` 中 `fileParser` 的 import 路径（当前为相对路径 `../../utils/fileParser`）
  - 更新 `src/lib/stream/index.ts` 桶文件，添加对新迁入文件的导出
  - _需求：3.4_

- [ ] 4. 统一 API 路由版本组织
  - 将 `src/app/api/chat/basic_agents/` 移动到 `src/app/api/chat/v1/basic_agents/`
  - 将 `src/app/api/chat/search_agents/` 移动到 `src/app/api/chat/v1/search_agents/`
  - 这三个 v1 路由（`basic_agents`、`search_agents`、`deep_research`）均已标记 `@deprecated`，前端已全部使用 `v2`，移入 `v1/` 目录后 API 路径会变化，但因为前端不再调用这些路由，不影响功能
  - 如果存在外部系统仍在调用旧路径，需在 README 中说明路径变更
  - _需求：3.1、3.2、3.3_

- [ ] 5. 清理废弃代码和空目录
  - 删除已迁移后残留的 `src/app/agents/` 目录（确认所有文件已迁移完毕）
  - 处理 `src/utils/index.ts`：当前内容全部被注释（`apiClient` 导出），检查 `apiClient` 是否有其他文件引用，若无则删除 `utils/index.ts`，若有则恢复导出
  - 处理 `src/types/transform/stream.ts`：该文件标记 `@deprecated` 但仍有 8 个文件引用（全在 `src/lib/stream/` 下），暂时保留并在文件头部添加注释说明引用方
  - _需求：2.1、2.2、2.3、2.4、2.5_

- [ ] 6. 删除所有分隔符风格的注释
  - 删除 `src/agents/eventStream/EventStreamAdapter.ts`（迁移后路径）中的 4 处分隔符注释：`// ---- LLM 相关事件 ----`、`// ---- 工具相关事件 ----`、`// ---- Chain/Graph 相关事件（用于节点进入/退出） ----`、`// ---- 自定义事件（LangGraph dispatchCustomEvent） ----`
  - 全局搜索确认无其他文件存在分隔符注释
  - _需求：2.6_

- [ ] 7. 更新所有 `index.ts` 桶文件的导出
  - 更新 `src/agents/index.ts`：确认导出路径正确（内部相对路径不变，应无需修改）
  - 更新 `src/lib/stream/index.ts`：添加对新迁入的 `createAgentEventSSEStream` 和 `createSSEStream` 的导出
  - 更新 `src/lib/index.ts`：如需要，添加对 `fileParser` 的导出
  - 检查 `src/types/index.ts`：确认导出路径正确
  - _需求：5.2_

- [ ] 8. 更新 `README.md` 项目结构描述
  - 更新项目结构树，反映以下变更：新增 `src/agents/` 目录、`src/app/agents/` 已移除、`api/utils/` 已移除、v1 路由目录结构变更
  - 删除对已不存在目录的引用（如 `pages/`）
  - 添加路径变更说明（v1 路由路径变更）
  - _需求：5.1、5.3_

- [ ] 9. 验证构建和运行
  - 运行 `pnpm build` 确保 TypeScript 编译无错误，所有 import 路径正确
  - 运行 `pnpm dev` 确保开发服务器可正常启动
  - 验证 Agent 功能（Chat、Search、DeepResearch）通过 v2 路由正常工作
  - _需求：1.4、5.4、5.5_
