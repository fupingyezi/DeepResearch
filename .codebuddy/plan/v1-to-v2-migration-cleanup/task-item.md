# 实施计划

- [ ] 1. 删除 v1 API 路由目录及所有文件
   - 删除 `src/app/api/chat/v1/` 整个目录，包含：
     - `basic_agents/route.ts`
     - `search_agents/route.ts`
     - `deep_research/route.ts`
   - 删除后确认 v2 路由 `src/app/api/chat/v2/route.ts` 不受影响
   - _需求：1.1、1.2、1.3_

- [ ] 2. 删除 v1 SSE 流处理函数
   - 删除 `src/lib/stream/createSSEStream.ts` 文件
   - _需求：2.1、2.3_

- [ ] 3. 删除 v1 状态处理函数文件
   - 删除 `src/utils/handleStateUpdate.ts` 整个文件（`handleStateUpdate` 和 `parseSearchResult` 均无外部引用，一并移除）
   - _需求：3.1、3.2、3.3_

- [ ] 4. 删除 v1 流处理基础设施
   - 删除 `src/lib/stream/StreamChunkTransformer.ts`
   - 删除 `src/lib/stream/processors/` 整个目录（含 `BaseChunkProcessor.ts`、`ChunkProcessor.ts`、`GroundingChunkProcessor.ts`、`ReasoningChunkProcessor.ts`、`TextChunkProcessor.ts`、`ToolCallChunkProcessor.ts`、`UsageChunkProcessor.ts`、`index.ts`）
   - 删除 `src/lib/stream/trackers/` 整个目录（含 `ToolCallTracker.ts`、`UsageTracker.ts`、`index.ts`）
   - 删除 `src/lib/stream/types.ts`（仅服务于上述被移除模块）
   - _需求：5.1、5.2、5.3、5.4_

- [ ] 5. 更新 `src/lib/stream/index.ts` 导出
   - 移除对 `StreamChunkTransformer`、`processors`、`trackers`、`types`、`createSSEStream` 的导出
   - 仅保留 `export { createAgentEventSSEStream } from "./createAgentEventSSEStream";`
   - _需求：2.2、5.5_

- [ ] 6. 移除 v1 类型定义
   - 从 `src/types/ChatInfoDefine.ts` 中删除 `SSEEvent` 类型定义（第 4-9 行）
   - 从 `src/types/index.ts` 中移除 `SSEEvent` 的导入（第 20 行）和导出（第 51 行）
   - 删除 `src/types/transform/stream.ts` 整个文件（所有类型均标记为 @deprecated，引用方已在步骤 4 中删除）
   - _需求：4.1、4.2、4.3_

- [ ] 7. 清理 `src/utils/chat/streamChatHandler.ts` 中的 v1 兼容代码
   - 在 `processStream` 方法中，移除 v1 兼容分支：删除 `if (this.config.agentType)` 条件判断，直接调用 `processStreamV2`；移除 `if` 之后的整段 v1 while 循环逻辑（约第 253-310 行）
   - 删除 `defaultStreamDataHandler` 私有方法（约第 394-399 行）
   - 将 `StreamChatConfig` 接口中的 `agentType` 字段从可选改为必填（移除 `?`）
   - _需求：6.1、6.2、6.3_

- [ ] 8. 更新 README.md 文档
   - 移除项目结构中 `v1/` 目录的描述行（`│   │   │   ├── v1/     # v1 兼容路由（deprecated）`）
   - 移除文件末尾关于 v1 路由 deprecated 的注意事项（`> **注意**：v1 路由...` 段落）
   - 更新 `stream/` 目录描述，移除"Chunk 转换"相关说明，改为反映 v2 事件流架构
   - _需求：7.1、7.2_
