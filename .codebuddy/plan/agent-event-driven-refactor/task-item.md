# 实施计划

- [ ] 1. 定义统一事件协议类型系统
  - 在 `src/types/` 下新建 `agentEvent.ts`，定义 `AgentEventType` 枚举（`llm_stream`、`llm_complete`、`tool_call_start`、`tool_call_result`、`state_update`、`human_interrupt`、`human_resume`、`error`、`lifecycle`、`node_enter`、`node_exit`、`task_progress`）
  - 定义 `AgentEvent` 基础接口，包含 `eventType`、`timestamp`、`agentId`、`payload`、`metadata` 字段
  - 为每种事件类型定义具体的 payload 接口（如 `LlmStreamPayload`、`StateUpdatePayload`、`ToolCallPayload` 等），使用 TypeScript 可辨识联合类型（Discriminated Union）实现类型安全
  - 在 `src/types/index.ts` 中导出新类型，保留现有的 `ApiStreamChunk`、`SSEEvent` 类型以支持渐进式迁移
  - _需求：1.1、1.2、1.4_

- [ ] 2. 实现 EventStreamAdapter — LangChain 原生事件到 AgentEvent 的映射层
  - 在 `src/app/agents/` 下新建 `eventStream/` 目录
  - 创建 `EventStreamAdapter.ts`，实现核心方法 `adaptStreamEvents(langchainEventStream): AsyncGenerator<AgentEvent>`，将 LangChain 的 `streamEvents` v2 事件（`on_chat_model_stream`、`on_tool_start`、`on_tool_end`、`on_chain_start`、`on_chain_end` 等）映射为统一的 `AgentEvent`
  - 实现事件过滤配置接口 `EventFilterConfig`，支持 `include_tags`、`include_names`、`exclude_names` 等参数，控制事件粒度
  - 实现自定义事件注入机制 `injectCustomEvent(event: AgentEvent)`，用于注入 `human_interrupt` 等 LangChain 不原生支持的事件
  - 编写单元测试验证各类 LangChain 事件到 `AgentEvent` 的映射正确性
  - _需求：2.1、2.2、2.4、2.5_

- [ ] 3. 重构 Agent 基类为组合模式架构
  - 重构 `src/app/agents/BaseAgentServer.ts`：将 `BaseAgentServer` 从纯抽象继承改为组合模式，提取三个核心模块接口：`EventEmitter`（事件发射）、`StreamProcessor`（流处理）、`ToolManager`（工具管理）
  - 新建 `src/app/agents/modules/EventEmitter.ts`，实现统一的 `emit(event: AgentEvent)` 方法，内部维护一个 `AsyncGenerator` 事件队列
  - 新建 `src/app/agents/modules/StreamProcessor.ts`，封装 `streamEvents` 调用逻辑，内部使用步骤 2 的 `EventStreamAdapter` 进行事件转换
  - 定义 `AgentCapabilityConfig` 接口，支持声明式配置：`{ tools?: Tool[], useStateGraph?: boolean, streamMode?: 'events' | 'messages' | 'values', checkpointer?: Checkpointer }`
  - 修改 `BaseAgentServer` 的 `createMessage` 方法签名，返回 `AsyncGenerator<AgentEvent>` 而非当前的 `ApiStream`（`AsyncGenerator<ApiStreamChunk>`）
  - _需求：3.1、3.2、3.3、3.4_

- [ ] 4. 迁移 ChatAgentServer 和 SearchAgentServer 到新架构
  - 重构 `src/app/agents/ChatAgentServer.ts`：移除对 `StreamChunkTransformer` 的依赖，改用 `StreamProcessor` 模块调用 `streamEvents` API，通过 `EventStreamAdapter` 输出 `AgentEvent`
  - 重构 `src/app/agents/SearchAgentServer.ts`：同样迁移到新的事件流架构，确保搜索工具调用事件（`tool_call_start`、`tool_call_result`）被正确发射
  - 确保两个 Agent 的 `createMessage` 方法返回 `AsyncGenerator<AgentEvent>`，且 `llm_stream` 事件的 payload 包含与原 `ApiStreamTextChunk` 等价的文本内容
  - _需求：1.1、2.1、3.1_

- [ ] 5. 改造 DeepResearch 工作流为事件驱动模式
  - 修改 `src/app/agents/DeepResearchAgentServer.ts`：将 `stream` + `streamMode: "values"` 替换为 `streamEvents` API，通过 `EventStreamAdapter` 自动捕获每个节点的进入/退出事件
  - 为 `src/app/agents/deepResearchWrokFlow/` 中的每个节点函数（`supervisor`、`simpleAnalyser`、`taskDecomposer`、`taskHandler`、`reportGenerationAssitant`、`humanDecision`）添加 LangGraph tag 标注，以便 `streamEvents` 能精确识别节点事件
  - 修改 `taskHandler.ts`：在处理每个子任务时发射 `task_progress` 事件（通过 LangGraph 的 `dispatchCustomEvent` 或状态更新机制）
  - 修改 `reportGenerationAssitant.ts`：将报告生成改为流式输出，使 LLM 的 `on_chat_model_stream` 事件能被 `streamEvents` 捕获并转换为 `llm_stream` 事件
  - 修改 `humanDecision.ts`：确保中断事件通过 `AgentEvent` 的 `human_interrupt` 类型发射，恢复时发射 `human_resume` 事件
  - 删除 `src/utils/handleStateUpdate.ts` 中的手动状态 diff 逻辑（`handleStateUpdate` 函数），保留 `parseSearchResult` 工具函数
  - _需求：6.1、6.2、6.3、6.4、6.5、6.6、2.3_

- [ ] 6. 重构 AgentManager 支持事件总线和动态注册
  - 修改 `src/app/agents/AgentManager.ts`：添加共享事件总线（`EventBus`）实例，支持 Agent 间通过事件通信
  - 实现 `registerAgent` / `unregisterAgent` 方法替代当前的 `registerFactory`，支持运行时动态注册/注销 Agent
  - 在 `src/app/agents/index.ts` 中更新导出，确保新的模块和类型都被正确导出
  - _需求：3.5_

- [ ] 7. 构建统一 SSE 传输层和合并 API 路由
  - 重构 `src/app/api/utils/createSSEStream.ts`：修改 `handler` 回调签名，使其接收 `AsyncGenerator<AgentEvent>` 而非手动 enqueue，内部自动将 `AgentEvent` 序列化为 SSE `data:` 行，每个事件包含 `eventType` 字段
  - 新建 `src/app/api/chat/v2/route.ts` 作为统一入口路由，接收 `agentType` 参数（`basic` | `search` | `deep_research`），根据类型从 `AgentManager` 获取对应 Agent 并调用 `createMessage`
  - 在统一路由中实现错误事件标准化：所有错误统一为 `AgentEvent` 的 `error` 类型，payload 包含 `errorCode`、`errorMessage`、`recoverable` 字段
  - 保留现有的 v1 路由（`basic_agents`、`search_agents`、`v1/deep_research`）不变，支持渐进式迁移
  - _需求：4.1、4.2、4.3、4.5、1.3_

- [ ] 8. 重构前端统一事件消费层
  - 新建 `src/utils/chat/EventConsumer.ts`，实现事件分发器：解析 SSE `data:` 行为 `AgentEvent` 对象，根据 `eventType` 分发到注册的 Handler
  - 实现内置 Handler 集合：`LlmStreamHandler`（处理 `llm_stream`，追加文本到消息内容）、`StateUpdateHandler`（处理 `state_update`/`task_progress`/`node_enter`/`node_exit`，更新 `deepResearchProcessStore`）、`HumanInterruptHandler`（处理 `human_interrupt`，触发中断 UI）、`LifecycleHandler`（处理 `lifecycle` 的 start/done 事件）
  - 实现 Handler 注册机制：`EventConsumer.registerHandler(eventType, handler)`，支持扩展新事件类型的处理逻辑
  - _需求：5.1、5.2、5.3、5.4、5.5_

- [ ] 9. 迁移前端调用层到 v2 API
  - 修改 `src/utils/chat/streamChatHandler.ts`：将 `processStream` 方法中的手动 SSE 解析逻辑替换为 `EventConsumer`，移除 `onStreamData` 回调中基于 `data.type` 的条件分支
  - 修改 `src/utils/chat/chatWithDeepResearch.ts`：将 `apiEndpoint` 从 `/api/chat/v1/deep_research` 改为 `/api/chat/v2`（附加 `agentType: 'deep_research'`），移除 `onStreamData` 中的手动状态分发逻辑（`start_analyse`、`tasks_initial`、`task_update`、`report`、`interrupt`），改由 `EventConsumer` 的 `StateUpdateHandler` 自动处理
  - 修改 `src/utils/chat/chatWithChatAssistant.ts` 和 `chatWithSearchAssistant.ts`：将 `apiEndpoint` 改为 `/api/chat/v2`（附加对应 `agentType`）
  - 保留 `StreamChatHandler` 中的 session 管理、消息持久化、abort 控制等业务逻辑不变
  - _需求：5.6、5.2、5.3、5.4_

- [ ] 10. 端到端集成验证与旧代码清理
  - 验证 Chat 模式：确认文本流式输出、工具调用展示与重构前行为一致
  - 验证 Search 模式：确认搜索结果展示、引用来源展示与重构前行为一致
  - 验证 DeepResearch 模式：确认 simpleAnalysis 展示、任务分解展示、任务进度更新、人工中断/恢复、报告流式渲染均与重构前行为一致
  - 验证 PostgreSQL checkpointer 在新架构下的状态持久化和恢复功能正常
  - 确认所有旧的 v1 路由仍可正常工作（渐进式迁移兼容性）
  - 清理不再使用的代码：`StreamChunkTransformer` 相关引用、`handleStateUpdate` 函数（保留 `parseSearchResult`）、旧的 `ApiStreamChunk` 类型（标记为 deprecated）
  - _需求：1.3、6.6_
