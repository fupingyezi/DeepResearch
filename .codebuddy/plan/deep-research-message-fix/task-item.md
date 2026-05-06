# 实施计划

- [ ] 1. 验证 `dispatchCustomEvent` 在 Tool 执行上下文中的可用性
   - 在 `SubAgentDispatcher.emitSubAgentResultEvent()` 中添加详细的调试日志，确认 `dispatchCustomEvent` 是否在 Lead Agent 的 `streamEvents` Tool 回调上下文中正常工作
   - 移除 `emitSubAgentResultEvent()` 和 `emitDispatchEvent()` 中的静默 `try/catch`，改为带日志的错误处理，明确记录失败原因
   - 文件：`src/agents/harness/SubAgentDispatcher.ts`
   - _需求：1.5、4.2_

- [ ] 2. 实现 Sub-agent 事件转发的备用机制
   - [ ] 2.1 在 `SubAgentDispatcher` 中增加事件队列机制
      - 新增一个 `pendingEvents: AgentEvent[]` 队列属性，用于在 `dispatchCustomEvent` 失败时暂存事件
      - 修改 `emitSubAgentResultEvent()` 方法：先尝试 `dispatchCustomEvent`，若失败则将构造好的 `AgentEvent` 推入 `pendingEvents` 队列
      - 新增 `flushPendingEvents(): AgentEvent[]` 方法，供外部消费队列中的事件
      - 文件：`src/agents/harness/SubAgentDispatcher.ts`
      - _需求：4.1、4.3_

   - [ ] 2.2 在 `AgentHarness.execute()` 中集成事件队列消费
      - 修改 `AgentHarness.execute()` 方法，在 `for await` 循环中每次 yield 事件后，检查 `SubAgentDispatcher` 的 `pendingEvents` 队列
      - 如果队列中有事件，依次 yield 这些事件，确保 Sub-agent 的自定义事件能进入父事件流
      - 文件：`src/agents/harness/AgentHarness.ts`
      - _需求：4.1、4.4_

   - [ ] 2.3 在 `LeadAgentHarness` 中将 `SubAgentDispatcher` 实例暴露给 `AgentHarness`
      - 修改 `LeadAgentHarness` 构造函数，将 `SubAgentDispatcher` 实例通过配置或方法传递给内部的 `AgentHarness`
      - 确保 `AgentHarness.execute()` 能访问到 `SubAgentDispatcher` 的事件队列
      - 文件：`src/agents/harness/LeadAgentHarness.ts`、`src/agents/harness/AgentHarness.ts`
      - _需求：4.1_

- [ ] 3. 修复前端 `StreamChatHandler` 中缺失的 `onTaskUpdate` 回调注册
   - 在 `StreamChatHandler.processStreamV2()` 的 `createStateUpdateHandler` 调用中，补充 `onTaskUpdate` 回调
   - `onTaskUpdate` 回调应调用 `this.config.onStreamData?.({ type: "task_update", payload: data }, this.accumulatedContent)` 并更新消息
   - 文件：`src/utils/chat/streamChatHandler.ts`
   - _需求：2.1、2.3_

- [ ] 4. 确保 `SubAgentDispatcher.emitSubAgentResultEvent()` 中 `taskHandler` 的 taskId 正确传递
   - 修改 `emitSubAgentResultEvent()` 中 `taskHandler` case 的 taskId 提取逻辑，使其能从 task 输入中可靠地解析出 taskId
   - 考虑在 Lead Agent 调用 `sub_agent_taskHandler` 时，要求 task 参数中包含结构化的 taskId 信息（可在 `taskHandlerConfig.description` 中补充说明）
   - 同时将 `task_progress` 事件中的 `status` 和 `result` 字段确保完整填充
   - 文件：`src/agents/harness/SubAgentDispatcher.ts`、`src/agents/harness/subagents/taskHandler.config.ts`
   - _需求：1.3、4.4_

- [ ] 5. 增强 `SubAgentDispatcher` 中 `dispatchCustomEvent` 的错误处理和日志
   - 将 `emitSubAgentResultEvent()` 和 `emitDispatchEvent()` 中的空 `catch` 块替换为带有 `console.warn` 的错误日志
   - 在 `dispatchCustomEvent` 失败时，记录失败的事件类型、Sub-agent 名称和错误信息，便于调试
   - 如果 `dispatchCustomEvent` 失败，触发步骤 2.1 中的备用事件队列机制
   - 文件：`src/agents/harness/SubAgentDispatcher.ts`
   - _需求：3.3、1.5_

- [ ] 6. 修复 `chatWithDeepResearch` 中 `onStreamData` 对 `task_update` 事件的处理
   - 在 `chatWithDeepResearch.ts` 的 `onStreamData` 回调中，确认 `task_update` 类型事件能正确调用 `params.updateTasks(data.payload)`
   - 验证 `updateTasks` 方法接收的 payload 格式与 `deepResearchProcessStore.updateTasks()` 期望的 `taskType` 格式一致
   - 文件：`src/utils/chat/chatWithDeepResearch.ts`
   - _需求：2.2_

- [ ] 7. 验证 `createAgentEventSSEStream` 的事件完整性
   - 检查 `createAgentEventSSEStream` 中的 `safeEnqueue` 方法，确保大型 JSON 事件（如包含完整报告的 `state_update`）不会因序列化问题丢失
   - 确认流正常结束时发射的 `lifecycle done` 事件不会与 `LeadAgentHarness.createMessage()` 中发射的 `lifecycle done` 事件重复
   - 文件：`src/lib/stream/createAgentEventSSEStream.ts`
   - _需求：3.1、3.4_

- [ ] 8. 端到端集成测试：验证完整的深度研究消息传递链路
   - 启动开发服务器，发起一次深度研究请求
   - 在浏览器 DevTools Network 面板中观察 SSE 流，确认以下事件按顺序到达前端：
     1. `lifecycle` (stage: start)
     2. `state_update` (stateType: simple_analysis) — 包含 researchTarget 和 simpleAnalysis
     3. `state_update` (stateType: tasks_initial) — 包含任务列表
     4. 多个 `task_progress` 事件 — 每个子任务完成时触发
     5. `state_update` (stateType: report) — 包含最终报告
     6. `lifecycle` (stage: done)
   - 验证前端 `DeepResearchProcess` 组件正确展示各阶段的进度和结果
   - 验证深度研究完成后，消息的 `deepResearchResult` 字段被正确保存到数据库
   - 验证刷新页面后，点击"查看研究过程"按钮能正确加载历史研究结果
   - _需求：1.1、1.2、1.3、1.4、3.4、5.1、5.2、5.3_
