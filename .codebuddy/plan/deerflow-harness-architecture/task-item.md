# 实施计划

- [ ] 1. 创建 deerflow-harness 目录骨架与路径别名
   - 创建 `src/deerflow-harness/` 目录及所有子目录（agents、tools、sandbox、models、mcp、skills、memory、middleware、config）
   - 在 `tsconfig.json` 中添加路径别名 `@deerflow-harness/*` → `src/deerflow-harness/*`
   - 创建 `src/deerflow-harness/index.ts` 入口文件（初始为空导出，后续逐步填充）
   - _需求：1.1、1.2、8.2_

- [ ] 2. 迁移 models 模块（src/lib/llm/ → deerflow-harness/models/）
   - 将 `src/lib/llm/` 下所有文件（factory.ts、classResolver.ts、patches.ts、resolveEnv.ts、configLoader.ts、models.config.ts、types.ts、index.ts）移动到 `src/deerflow-harness/models/`
   - 更新 `src/deerflow-harness/models/index.ts` 的导出
   - 删除原 `src/lib/llm/` 目录
   - 更新 `src/lib/index.ts` 为从 `@deerflow-harness/models` re-export `createChatModel`、`CreateModelOptions` 等（兼容层）
   - _需求：3.1、3.2、3.3_

- [ ] 3. 迁移 agents 模块（src/agents/harness/ → deerflow-harness/agents/）
   - 将 `AgentHarness.ts`、`LeadAgentHarness.ts`、`SubAgentDispatcher.ts`、`SubAgentRegistry.ts`、`types.ts`、`subagent.ts` 移动到 `src/deerflow-harness/agents/`
   - 更新所有内部 import 路径（如 `@/lib` → `../models`、`./hooks` → `../middleware`）
   - 创建 `src/deerflow-harness/agents/index.ts` 导出所有公开 API
   - _需求：2.1、2.3_

- [ ] 4. 迁移 middleware 模块（src/agents/harness/hooks/ → deerflow-harness/middleware/）
   - 将 `HooksManager.ts`、`hooks.ts`（类型定义）、`hooks/HumanReviewHook.ts` 移动到 `src/deerflow-harness/middleware/`
   - 创建 `src/deerflow-harness/middleware/index.ts` 导出所有中间件
   - 更新 agents 模块中对 hooks 的引用路径
   - _需求：5.1、5.2_

- [ ] 5. 迁移 tools 模块（src/agents/tools/ → deerflow-harness/tools/）
   - 将 `searchWebTool.ts` 移动到 `src/deerflow-harness/tools/`
   - 创建 `src/deerflow-harness/tools/index.ts` 导出所有工具
   - 删除原 `src/agents/tools/` 目录
   - _需求：4.1、4.2、4.3_

- [ ] 6. 迁移 config 模块（subagents 配置 → deerflow-harness/config/）
   - 将 `src/agents/harness/subagents/` 下的所有 config 文件移动到 `src/deerflow-harness/config/subagents/`
   - 将 `models.config.ts` 从 models/ 中引用或在 config/ 中 re-export
   - 创建 `src/deerflow-harness/config/index.ts` 统一导出配置
   - 删除原 `src/agents/harness/subagents/` 目录
   - _需求：6.1、6.2、6.3_

- [ ] 7. 创建空骨架模块（sandbox、mcp、skills、memory）
   - 创建 `src/deerflow-harness/sandbox/index.ts`，导出空接口 `SandboxProvider`
   - 创建 `src/deerflow-harness/mcp/index.ts`，导出空接口 `MCPAdapter`
   - 创建 `src/deerflow-harness/skills/index.ts`，导出空接口 `Skill`
   - 创建 `src/deerflow-harness/memory/index.ts`，导出空接口 `MemoryProvider`
   - _需求：7.1、7.2_

- [ ] 8. 完善 deerflow-harness/index.ts 统一入口
   - 从各子模块 re-export 所有公开 API（agents、models、tools、middleware、config、sandbox、mcp、skills、memory）
   - 确保 `import { createChatModel } from "@deerflow-harness/models"` 和 `import { AgentHarness } from "@deerflow-harness/agents"` 均可正常工作
   - _需求：1.2、8.1、8.3_

- [ ] 9. 更新所有外部调用方的 import 路径
   - `src/agents/ChatAgentServer.ts`：`@/lib` → `@deerflow-harness/models`
   - `src/agents/SearchAgentServer.ts`：`@/lib` → `@deerflow-harness/models`
   - `src/agents/BaseAgentServer.ts`：`@/lib` → `@deerflow-harness/models`
   - `src/agents/DeepResearchAgentServer.ts`：`./harness/LeadAgentHarness` → `@deerflow-harness/agents`
   - `src/agents/AgentManager.ts`：`./harness/subagent` 和 `./harness/SubAgentRegistry` → `@deerflow-harness/agents`
   - `src/agents/index.ts`：`./harness` → `@deerflow-harness`
   - `src/app/api/chat/v2/route.ts`：更新 harness 相关引用
   - _需求：9.1、9.2、9.3、9.4_

- [ ] 10. 删除旧目录并验证
   - 删除 `src/agents/harness/` 目录（确认所有文件已迁移）
   - 删除 `src/lib/llm/` 目录（确认所有文件已迁移）
   - 删除 `src/agents/tools/` 目录（确认所有文件已迁移）
   - 更新 `src/lib/index.ts` 为纯兼容层（仅 re-export from deerflow-harness）
   - grep 验证：项目中不存在对 `@/agents/harness`、`@/lib/llm`、`./harness` 的直接引用
   - _需求：2.2、3.2、4.2、5.2、6.2、8.4、9.4_
