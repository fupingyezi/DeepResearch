# 实施计划：Agent Harness 架构重构

---

- [ ] 1. 定义 Harness 核心类型系统与接口
   - 在 `src/app/agents/harness/` 目录下创建以下类型定义文件：
     - `types.ts`：定义 `HarnessConfig`（包含 agentId、systemPrompt、model、tools、timeout、hooks 等字段）、`HarnessContext`（独立执行上下文，包含 messages、state、metadata）、`HarnessLifecycle`（`initialize` → `execute` → `cleanup` 三阶段枚举）、`HarnessExecutionResult`（统一的执行结果格式）
     - `hooks.ts`：定义 `HarnessHook` 接口（包含 `name`、`scope`、`priority`、`onFailure` 字段），以及 `PreExecuteHook`、`PreToolUseHook`、`PostToolUseHook`、`PostExecuteHook` 四种 Hook 类型接口，每种 Hook 接收对应阶段的上下文参数并返回修改后的上下文或 `abort` 信号
     - `subagent.ts`：定义 `SubAgentConfig` 接口（包含 `name`、`description`、`systemPrompt`、`model`、`tools`、`timeout`、`hooks` 字段），以及 `SubAgentRegistry` 接口（`register`、`unregister`、`get`、`getAll`、`toTools` 方法签名）
   - 在 `src/types/agentEvent.ts` 中扩展 `AgentEventType` 枚举，新增 `SUB_AGENT_DISPATCH = "sub_agent_dispatch"` 和 `HARNESS_LIFECYCLE = "harness_lifecycle"` 两个事件类型，并定义对应的 Payload 接口和 Event 接口，将它们加入 `AgentEvent` 联合类型
   - _需求：1.1、1.2、2.1-2.6、3.1、4.1、7.5_

- [ ] 2. 实现 AgentHarness 运行时容器核心类
   - 在 `src/app/agents/harness/AgentHarness.ts` 中实现 `AgentHarness` 类：
     - 构造函数接收 `HarnessConfig`，初始化独立的 `HarnessContext`（包含隔离的 system prompt、tools 绑定、状态存储）
     - 实现 `initialize()` 方法：创建 LangGraph `createReactAgent` 实例（使用 `HarnessConfig` 中的 model、systemPrompt、tools），绑定工具沙箱（仅允许配置中声明的工具）
     - 实现 `execute(input)` 方法：调用 LangGraph agent 的 `streamEvents` API，通过现有的 `EventStreamAdapter` 将事件转换为 `AgentEvent` 流，同时自动采集执行指标（耗时、token 用量）
     - 实现 `cleanup()` 方法：释放 agent 实例和上下文资源，确保不泄漏到其他 Harness
     - 实现超时控制：使用 `AbortController` + `setTimeout` 机制，超时时强制终止并发出 `ErrorEvent`
   - 导出 `AgentHarness` 类，并在 `src/app/agents/harness/index.ts` 中统一导出
   - _需求：1.1、1.2、1.3、1.4、1.5、1.6_

- [ ] 3. 实现 Hooks 生命周期钩子管理器
   - 在 `src/app/agents/harness/HooksManager.ts` 中实现 `HooksManager` 类：
     - 维护四个 Hook 队列（`preExecute`、`preToolUse`、`postToolUse`、`postExecute`），每个队列按 `priority` 排序
     - 实现 `register(hook)` 方法：根据 Hook 的 `scope`（全局 / 特定 Agent 类型 / 特定实例）和 `phase`（preExecute 等）注册到对应队列
     - 实现 `runPreExecute(context)` / `runPreToolUse(toolCall)` / `runPostToolUse(toolResult)` / `runPostExecute(result)` 方法：按优先级顺序执行 Hook 链，支持 Hook 修改输入/输出或返回 `abort` 信号中断执行
     - 实现错误处理：根据 Hook 的 `onFailure` 配置（`skip` 或 `abort`）决定是跳过还是中断，并发出 `ErrorEvent`
     - Hook 链最大深度限制为 10 层
   - 将 `HooksManager` 集成到 `AgentHarness` 的 `execute()` 流程中：在 `initialize` 后触发 `preExecute`，在工具调用前后触发 `preToolUse` / `postToolUse`，在 `execute` 完成后触发 `postExecute`
   - _需求：2.1、2.2、2.3、2.4、2.5、2.6_

- [ ] 4. 实现 Sub-agent 注册表与声明式配置加载
   - 在 `src/app/agents/harness/SubAgentRegistry.ts` 中实现 `SubAgentRegistry` 类（单例模式）：
     - 维护一个 `Map<string, SubAgentConfig>` 存储所有已注册的 Sub-agent 配置
     - 实现 `register(config: SubAgentConfig)` / `unregister(name: string)` / `get(name: string)` / `getAll()` 方法
     - 实现 `toTools()` 方法：遍历所有已注册的 Sub-agent 配置，为每个配置生成一个 LangChain `DynamicStructuredTool`（name 为 Sub-agent 名称，description 为 Sub-agent 描述，input schema 包含 `task: string` 字段），返回 Tool 数组
   - 在 `src/app/agents/harness/subagents/` 目录下创建声明式配置文件，将现有 4 个工作流节点迁移为 Sub-agent 配置：
     - `simpleAnalyser.config.ts`：提取 `simpleAnalyser.ts` 中的 systemPrompt，配置 tools 为空
     - `taskDecomposer.config.ts`：提取 `taskDecomposer.ts` 中的 systemPrompt，配置 tools 为空
     - `taskHandler.config.ts`：提取 `taskHandler.ts` 中的 systemPrompt，配置 tools 为 `[searchWebTool]`
     - `reportGenerator.config.ts`：提取 `reportGenerationAssitant.ts` 中的 systemPrompt，配置 tools 为空
   - 在 `src/app/agents/harness/subagents/index.ts` 中实现自动扫描加载逻辑：导入所有 `.config.ts` 文件并调用 `SubAgentRegistry.register()` 注册
   - _需求：4.1、4.2、4.3、4.4、4.5_

- [ ] 5. 实现 Sub-agent 工具化调度机制
   - 在 `src/app/agents/harness/SubAgentDispatcher.ts` 中实现 `SubAgentDispatcher` 类：
     - 实现 `createSubAgentTool(config: SubAgentConfig)` 方法：为单个 Sub-agent 配置创建 `DynamicStructuredTool`，其 `func` 实现为：
       1. 创建一个新的 `AgentHarness` 实例（使用 Sub-agent 的 config）
       2. 调用 `harness.initialize()` → `harness.execute(task)` → `harness.cleanup()`
       3. 收集 Sub-agent 执行过程中产生的 `AgentEvent` 事件，通过父 Harness 的事件流转发（保持可观测性）
       4. 将 Sub-agent 的最终文本输出作为 Tool Result 返回给 Lead Agent
     - 实现并发控制：维护一个信号量（默认最大并发数 5），防止同时运行过多 Sub-agent
     - 实现嵌套深度限制：通过 `HarnessContext` 中的 `depth` 字段追踪嵌套层级，超过 2 层时拒绝创建新的 Sub-agent
   - 在 `SubAgentDispatcher` 的 Tool `func` 中，发射 `SUB_AGENT_DISPATCH` 事件（包含 Sub-agent 名称、任务描述、开始/完成状态）
   - _需求：3.1、3.2、3.3、3.4、3.5、3.6_

- [ ] 6. 实现 Lead Agent 核心引擎
   - 在 `src/app/agents/harness/LeadAgentHarness.ts` 中实现 `LeadAgentHarness` 类（继承或组合 `AgentHarness`）：
     - 构造函数中：从 `SubAgentRegistry` 获取所有 Sub-agent Tool，与基础工具（如 `searchWebTool`）合并，作为 Lead Agent 的完整工具列表
     - 使用 LangGraph 的 `createReactAgent` 创建 Lead Agent 实例，配置 ReAct 循环最大迭代次数（默认 20 次）
     - 实现 `createMessage(messages, metadata)` 方法：返回 `AgentEventStream`，内部流程为：
       1. 发射 `LifecycleEvent(start)`
       2. 调用 `AgentHarness.execute()`，Lead Agent 的 LLM 通过 function calling 自主决定调用基础工具或 Sub-agent Tool
       3. 当 LLM 调用 Sub-agent Tool 时，`SubAgentDispatcher` 自动在独立 Harness 中执行 Sub-agent 并返回结果
       4. Lead Agent 基于 Sub-agent 返回的结果继续推理，直到生成最终回答
       5. 发射 `LifecycleEvent(done)`
   - 编写 Lead Agent 的 system prompt：描述其作为调度中心的角色，说明可用的 Sub-agent Tool 及其用途，指导 LLM 何时直接回答、何时调度 Sub-agent
   - _需求：5.1、5.2、5.3、5.4、5.5_

- [ ] 7. 将 humanDecision 迁移为 Harness Hook
   - 在 `src/app/agents/harness/hooks/` 目录下创建 `HumanReviewHook.ts`：
     - 实现 `HumanReviewHook` 作为 `PreExecuteHook`，在 Sub-agent 执行前检查是否需要人工审核
     - 当需要人工审核时：发射 `HumanInterruptEvent`（使用 `dispatchCustomEvent("human_interrupt", ...)`），调用 LangGraph 的 `interrupt()` 暂停执行，等待用户通过 `Command({ resume })` 恢复
     - 将此 Hook 注册到 `taskDecomposer` Sub-agent 的 hooks 配置中（因为现有逻辑是在 taskDecomposer 之后触发人工审核）
   - 确保 `HumanResumeEvent` 的发射逻辑与现有 `DeepResearchAgentServer.createMessage()` 中的 `isResume` 处理保持兼容
   - _需求：6.3、6.4_

- [ ] 8. 适配 AgentManager 与 DeepResearchAgentServer
   - 修改 `src/app/agents/AgentManager.ts`：
     - 新增 `SubAgentConfig` 相关的注册方法：`registerSubAgent(config: SubAgentConfig)` 和 `getSubAgentRegistry(): SubAgentRegistry`
     - 当新的 Sub-agent 配置被注册时，自动调用 `SubAgentRegistry.register()` 并触发 Lead Agent 工具列表的更新
     - 保持现有的 `AgentType` 枚举、`registerAgent()`、`getAgent()` 方法不变，确保向后兼容
   - 重写 `src/app/agents/DeepResearchAgentServer.ts`：
     - 将内部实现从 `createDeepResearchWorkflow()`（StateGraph 固定图）替换为 `LeadAgentHarness`
     - `createMessage()` 方法内部委托给 `LeadAgentHarness.createMessage()`，保持方法签名和返回类型（`AgentEventStream`）不变
     - 保持 `deepResearchId`、`isResume` 等元数据的处理逻辑兼容
   - _需求：8.1、8.2、8.3、8.4、6.2_

- [ ] 9. 事件流兼容性适配与 EventStreamAdapter 扩展
   - 修改 `src/app/agents/eventStream/EventStreamAdapter.ts`：
     - 在 `handleCustomEvent()` 方法中新增对 `sub_agent_dispatch` 和 `harness_lifecycle` 自定义事件的处理逻辑
     - 确保 Sub-agent 在独立 Harness 中产生的 `state_update`、`task_progress`、`human_interrupt` 事件能正确转发到父事件流
   - 修改 `src/app/agents/modules/StreamProcessor.ts`：
     - 确保 `processStreamEvents()` 方法能处理 Lead Agent 的 ReAct 循环事件流（不再是固定图的节点事件）
     - 更新 `workflowNodeNames` 的使用方式：从固定的节点名称列表改为动态的 Sub-agent 名称列表
   - 验证 `src/app/api/utils/createAgentEventSSEStream.ts` 无需修改（因为它只消费 `AgentEvent` 流，不关心内部实现）
   - 验证 `src/app/api/chat/v2/route.ts` 无需修改（因为它通过 `AgentManager.getAgent()` 获取 Agent，接口不变）
   - _需求：7.1、7.2、7.3、7.4、7.5_

- [ ] 10. 标记废弃旧工作流并更新模块导出
   - 在 `src/app/agents/deepResearchWrokFlow/` 目录下的所有文件顶部添加 `@deprecated` JSDoc 注释，标注"已被 Harness 架构替代，请使用 `src/app/agents/harness/` 下的实现"
   - 更新 `src/app/agents/index.ts` 导出：
     - 新增导出 `AgentHarness`、`LeadAgentHarness`、`SubAgentRegistry`、`SubAgentDispatcher`、`HooksManager` 及相关类型
     - 将 `DEEP_RESEARCH_NODE_NAMES` 的导出标记为 `@deprecated`
   - 更新 `src/app/agents/harness/index.ts`：统一导出 Harness 模块的所有公共 API
   - _需求：6.5、8.4_
