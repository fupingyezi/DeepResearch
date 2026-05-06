# 需求文档：深度研究消息无法传递到前端的Bug修复

## 引言

本项目是一个基于 Next.js 14 + LangChain/LangGraph 构建的智能聊天应用（mini-DeepResearch），参考了 [deer-flow](https://github.com/bytedance/deer-flow) 的架构设计。项目的核心功能之一是**深度研究（Deep Research）**，通过 Lead Agent 调度多个 Sub-agent（simpleAnalyser、taskDecomposer、taskHandler、reportGenerator）完成复杂的研究任务。

### 当前问题

深度研究过程中，Sub-agent 产生的状态更新事件（如初步分析结果、任务列表、任务进度、最终报告等）**无法正确传递到前端**，导致前端的 `DeepResearchProcess` 组件无法展示研究进度和结果。

### 消息传递链路分析

当前项目的消息传递链路如下：

```
前端 chatWithDeepResearch()
  → StreamChatHandler.execute()
    → fetch POST /api/chat/v2
      → DeepResearchAgentServer.createMessage()
        → LeadAgentHarness.createMessage()
          → AgentHarness.execute()
            → LangChain Agent.streamEvents()
              → EventStreamAdapter.adaptStreamEvents()
                → 产出 AgentEvent
      → createAgentEventSSEStream() 序列化为 SSE
    ← SSE 流返回
  → EventConsumer.consumeSSEStream() 解析 SSE
    → 根据 eventType 分发到注册的 Handler
      → STATE_UPDATE → onStreamData → 更新 deepResearchProcessStore
      → TASK_PROGRESS → onStreamData → 更新 tasks
      → LLM_STREAM → 更新 accumulatedContent
```

### 核心问题定位

经过代码分析，发现以下关键问题：

1. **Sub-agent 事件丢失**：`SubAgentDispatcher.executeSubAgent()` 中，Sub-agent 在独立的 `AgentHarness` 中执行，其产生的事件通过 `for await (const event of harness.execute(task))` 收集，但这些事件**仅被收集为文本输出**（`outputParts`），并未转发到父事件流中。虽然 `onSubAgentEvent` 回调存在，但在 `LeadAgentHarness` 创建 `SubAgentDispatcher` 时**并未传入 `onSubAgentEvent` 回调**。

2. **dispatchCustomEvent 上下文问题**：`SubAgentDispatcher.emitSubAgentResultEvent()` 使用 `dispatchCustomEvent` 发射自定义事件（如 `state_update`、`task_progress`），但这个函数**依赖 LangGraph 的运行时上下文**。当 Sub-agent 的 Tool 在 Lead Agent 的 `streamEvents` 中被调用时，`dispatchCustomEvent` 可能无法正确地将事件注入到 Lead Agent 的事件流中，导致事件丢失。代码中也有 `try/catch` 静默忽略了这个错误。

3. **EventStreamAdapter 自定义事件映射**：`EventStreamAdapter.handleCustomEvent()` 能正确处理 `state_update`、`task_progress` 等自定义事件，但前提是这些事件能够被 `streamEvents` 捕获到。如果 `dispatchCustomEvent` 在 Tool 执行上下文中失败，这些事件就永远不会到达 `EventStreamAdapter`。

4. **前端 EventConsumer 注册缺失**：在 `StreamChatHandler.processStreamV2()` 中，`createStateUpdateHandler` 注册了 `onSimpleAnalysis`、`onTasksInitial`、`onReport` 三个回调，但**缺少 `onTaskUpdate` 回调**，导致即使 `task_update` 类型的 `STATE_UPDATE` 事件到达前端，也不会被处理。

5. **deer-flow 参考架构差异**：deer-flow 项目使用 Python + LangGraph 的原生 `interrupt` 和 `Command` 机制，事件流通过 LangGraph 的 `stream` 方法原生支持。而本项目使用 TypeScript + LangChain JS，`streamEvents` 的行为和 Python 版本存在差异，特别是在 Tool 内部发射自定义事件的能力上。

---

## 需求

### 需求 1：修复 Sub-agent 事件转发机制

**用户故事：** 作为一名使用深度研究功能的用户，我希望在研究过程中能实时看到各阶段的进度（初步分析、任务拆解、任务执行、报告生成），以便了解研究的当前状态。

#### 验收标准

1. WHEN Sub-agent（simpleAnalyser）完成执行 THEN 系统 SHALL 将 `state_update`（stateType: `simple_analysis`）事件传递到前端，前端展示研究目标和开场白
2. WHEN Sub-agent（taskDecomposer）完成执行 THEN 系统 SHALL 将 `state_update`（stateType: `tasks_initial`）事件传递到前端，前端展示任务列表并打开进度侧边栏
3. WHEN Sub-agent（taskHandler）完成单个任务执行 THEN 系统 SHALL 将 `task_progress` 事件传递到前端，前端更新对应任务的状态和结果
4. WHEN Sub-agent（reportGenerator）完成执行 THEN 系统 SHALL 将 `state_update`（stateType: `report`）事件传递到前端，前端展示最终研究报告
5. IF `dispatchCustomEvent` 在 Tool 执行上下文中不可用 THEN 系统 SHALL 提供替代的事件传递机制，确保事件不丢失

### 需求 2：修复前端事件处理器注册完整性

**用户故事：** 作为一名使用深度研究功能的用户，我希望每个子任务的执行进度能实时更新到界面上，以便我能跟踪每个任务的完成情况。

#### 验收标准

1. WHEN 前端收到 `STATE_UPDATE` 事件且 stateType 为 `task_update` THEN EventConsumer SHALL 正确分发到 `onTaskUpdate` 回调
2. WHEN 前端收到 `TASK_PROGRESS` 事件 THEN EventConsumer SHALL 正确分发到 `onStreamData` 回调，并更新对应任务的状态
3. WHEN 前端 `StreamChatHandler` 注册事件处理器时 THEN 系统 SHALL 确保所有 `StateUpdateHandler` 的回调（`onSimpleAnalysis`、`onTasksInitial`、`onTaskUpdate`、`onReport`）都被正确注册

### 需求 3：确保 SSE 流的完整性和可靠性

**用户故事：** 作为一名使用深度研究功能的用户，我希望研究过程不会因为事件传递失败而中断或丢失数据，以便获得完整的研究结果。

#### 验收标准

1. WHEN AgentEvent 从服务端产生 THEN `createAgentEventSSEStream` SHALL 将其完整序列化为 SSE data 行并发送到前端
2. WHEN SSE 流中出现 JSON 解析错误 THEN EventConsumer SHALL 记录错误日志但不中断流的消费
3. IF 深度研究过程中某个 Sub-agent 执行失败 THEN 系统 SHALL 发射 ERROR 事件通知前端，而非静默忽略
4. WHEN 深度研究正常完成 THEN 系统 SHALL 发射 LIFECYCLE done 事件，前端正确结束流消费

### 需求 4：SubAgentDispatcher 事件注入机制优化

**用户故事：** 作为一名开发者，我希望 Sub-agent 的执行结果能通过可靠的机制注入到父事件流中，以便前端能接收到所有深度研究的中间状态。

#### 验收标准

1. WHEN `LeadAgentHarness` 创建 `SubAgentDispatcher` 时 THEN 系统 SHALL 提供有效的事件转发机制（如 `onSubAgentEvent` 回调或 `EventStreamAdapter.injectCustomEvent`）
2. WHEN Sub-agent Tool 在 Lead Agent 的 `streamEvents` 上下文中执行时 THEN `dispatchCustomEvent` SHALL 能正确将事件注入到 Lead Agent 的事件流中
3. IF `dispatchCustomEvent` 不可用 THEN 系统 SHALL 回退到替代方案（如通过 `EventStreamAdapter.injectCustomEvent` 注入事件）
4. WHEN Sub-agent 事件被转发时 THEN 事件 SHALL 保留原始的 payload 结构，不丢失任何字段

### 需求 5：深度研究结果持久化和恢复

**用户故事：** 作为一名使用深度研究功能的用户，我希望深度研究完成后结果能被正确保存，并在重新打开时能查看历史研究结果。

#### 验收标准

1. WHEN 深度研究正常完成 THEN `StreamChatHandler.cleanup()` SHALL 正确调用 `getDeepResearchResult` 获取完整的研究结果（包含 researchTarget、tasks、report）
2. WHEN 深度研究结果保存到数据库 THEN 消息的 `deepResearchResult` 字段 SHALL 包含完整的研究数据
3. WHEN 用户点击"查看研究过程"按钮 THEN 系统 SHALL 从数据库加载并正确展示历史研究结果
4. IF 深度研究过程中被用户中断 THEN 系统 SHALL 保存已完成的部分结果，并标记消息状态为相应的中断状态

---

## 技术约束

1. 项目使用 TypeScript + Next.js 14 App Router，服务端逻辑运行在 Edge/Node.js Runtime
2. LangChain JS 的 `streamEvents` v2 和 `dispatchCustomEvent` 的行为需要验证其在 Tool 执行上下文中的可用性
3. 前端使用 Zustand 进行状态管理，所有深度研究状态集中在 `deepResearchProcessStore` 中
4. SSE 流使用 `ReadableStream` API 构建，需要确保事件的顺序性和完整性
5. 参考 deer-flow 的架构设计，但需要适配 TypeScript/JavaScript 生态的差异
