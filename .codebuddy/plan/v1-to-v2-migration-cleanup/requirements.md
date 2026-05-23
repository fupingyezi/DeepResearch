# 需求文档

## 引言

本项目已完成从 v1 分散路由架构到 v2 统一路由架构的核心迁移工作。前端三个聊天函数（`chatWithChatAssistant`、`chatWithSearchAssistant`、`chatWithDeepResearch`）均已切换到 `/api/chat/v2` 统一路由，v2 后端路由和前端 `EventConsumer` 事件消费层也已就绪。

然而，项目中仍残留大量标记为 `@deprecated` 的 v1 代码，包括 v1 路由文件、v1 SSE 流处理函数、v1 状态处理函数、v1 类型定义，以及前端 `StreamChatHandler` 中的 v1 兼容分支代码。这些残留代码增加了维护成本和代码复杂度，需要彻底清理。

本次迁移清理的目标是：**移除所有 v1 残留代码和 @deprecated 标记的模块，使项目完全运行在 v2 统一事件驱动架构上。**

**代码风格约束：** 在迁移清理过程中，不要添加分隔符注释（如 `// ========`、`// --------`、`/* --- xxx --- */` 等）。保持代码简洁，仅保留必要的功能性注释。

## 需求

### 需求 1：移除 v1 API 路由文件

**用户故事：** 作为一名开发者，我希望移除已废弃的 v1 API 路由文件，以便减少代码冗余和维护负担。

#### 验收标准

1. WHEN 迁移完成 THEN 系统 SHALL 不再包含 `src/app/api/chat/v1/` 目录及其下的所有文件（`basic_agents/route.ts`、`search_agents/route.ts`、`deep_research/route.ts`）
2. WHEN 删除 v1 路由后 THEN 系统 SHALL 确保 v2 路由 `/api/chat/v2` 能正常处理所有三种 agentType（basic、search、deep_research）的请求
3. IF 有任何代码引用了 v1 路由路径（如 `/api/chat/v1/basic_agents`） THEN 系统 SHALL 确保这些引用已被移除或更新

### 需求 2：移除 v1 SSE 流处理函数

**用户故事：** 作为一名开发者，我希望移除已废弃的 `createSSEStream` 函数，以便统一使用 v2 的 `createAgentEventSSEStream` 进行 SSE 流处理。

#### 验收标准

1. WHEN 迁移完成 THEN 系统 SHALL 不再包含 `src/lib/stream/createSSEStream.ts` 文件
2. WHEN 删除 `createSSEStream` 后 THEN `src/lib/stream/index.ts` SHALL 移除对 `createSSEStream` 的导出
3. IF 有任何代码引用了 `createSSEStream` THEN 系统 SHALL 确保这些引用已被移除（v1 路由文件的删除将自动消除这些引用）

### 需求 3：移除 v1 状态处理函数

**用户故事：** 作为一名开发者，我希望移除已废弃的 `handleStateUpdate` 函数，以便统一使用 v2 的 `EventStreamAdapter + dispatchCustomEvent` 事件驱动架构。

#### 验收标准

1. WHEN 迁移完成 THEN 系统 SHALL 不再包含 `src/utils/handleStateUpdate.ts` 文件中的 `handleStateUpdate` 函数
2. IF `parseSearchResult` 函数仍被其他模块需要 THEN 系统 SHALL 将其迁移到合适的位置；IF 不再需要 THEN 系统 SHALL 一并移除
3. WHEN 删除后 THEN 系统 SHALL 确保没有任何代码引用 `handleStateUpdate`

### 需求 4：移除 v1 类型定义

**用户故事：** 作为一名开发者，我希望清理仅服务于 v1 架构的类型定义，以便保持类型系统的简洁和一致性。

#### 验收标准

1. WHEN 迁移完成 THEN `src/types/ChatInfoDefine.ts` 中的 `SSEEvent` 类型 SHALL 被移除（前提是确认无其他非 v1 代码引用）
2. WHEN 迁移完成 THEN `src/types/index.ts` SHALL 移除对 `SSEEvent` 的导入和导出
3. WHEN 迁移完成 THEN `src/types/transform/stream.ts` 中标记为 `@deprecated` 的 `ApiStream`、`ApiStreamChunk` 及其所有子类型 SHALL 被移除（前提是确认 `StreamChunkTransformer` 和 processors 也一并移除）

### 需求 5：移除 v1 流处理基础设施

**用户故事：** 作为一名开发者，我希望移除仅服务于 v1 架构的流处理基础设施（`StreamChunkTransformer`、所有 Chunk Processors、Trackers），以便减少无用代码。

#### 验收标准

1. WHEN 迁移完成 THEN 系统 SHALL 不再包含 `src/lib/stream/StreamChunkTransformer.ts` 文件
2. WHEN 迁移完成 THEN 系统 SHALL 不再包含 `src/lib/stream/processors/` 目录及其所有文件（`BaseChunkProcessor.ts`、`ChunkProcessor.ts`、`GroundingChunkProcessor.ts`、`ReasoningChunkProcessor.ts`、`TextChunkProcessor.ts`、`ToolCallChunkProcessor.ts`、`UsageChunkProcessor.ts`、`index.ts`）
3. WHEN 迁移完成 THEN 系统 SHALL 不再包含 `src/lib/stream/trackers/` 目录及其所有文件（`ToolCallTracker.ts`、`UsageTracker.ts`、`index.ts`）
4. WHEN 迁移完成 THEN 系统 SHALL 不再包含 `src/lib/stream/types.ts` 文件（如果它仅服务于上述被移除的模块）
5. WHEN 删除后 THEN `src/lib/stream/index.ts` SHALL 更新导出，移除对已删除模块的引用

### 需求 6：清理前端 v1 兼容代码

**用户故事：** 作为一名开发者，我希望移除 `StreamChatHandler` 中的 v1 兼容分支代码，以便简化流处理逻辑。

#### 验收标准

1. WHEN 迁移完成 THEN `src/utils/chat/streamChatHandler.ts` 中 `processStream` 方法 SHALL 移除 v1 兼容模式的分支逻辑（即 `if (!this.config.agentType)` 的 v1 分支和 `defaultStreamDataHandler` 方法）
2. WHEN 迁移完成 THEN `processStream` 方法 SHALL 直接使用 v2 的 `EventConsumer` 逻辑处理所有流
3. IF `agentType` 字段在 `StreamChatConfig` 中变为必填 THEN 系统 SHALL 更新类型定义，将 `agentType` 从可选改为必填
4. WHEN 迁移完成 THEN 系统 SHALL 确保 `chatWithChatAssistant`、`chatWithSearchAssistant`、`chatWithDeepResearch`、`reChatWithAssistant` 的功能不受影响

### 需求 7：更新项目文档

**用户故事：** 作为一名开发者，我希望更新 README 文档，移除关于 v1 路由的说明，以便文档与代码保持一致。

#### 验收标准

1. WHEN 迁移完成 THEN `README.md` SHALL 移除关于 v1 路由已 deprecated 的注意事项说明
2. WHEN 迁移完成 THEN `README.md` 中的项目结构描述 SHALL 反映清理后的目录结构（不再包含 v1 目录）
