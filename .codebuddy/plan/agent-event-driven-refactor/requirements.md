# 需求文档：Agent 架构重构 — 事件驱动 + 统一事件流

## 引言

当前 mini-DeepResearch 项目的 Agent 架构存在以下核心问题：

1. **工作流形式僵化**：`DeepResearchAgentServer` 采用硬编码的 `StateGraph` 工作流（supervisor → simpleAnalyser → taskDecomposer → taskHandler → reportGenerationAssitant），节点之间的流转逻辑固定在 `addConditionalEdges` 中，难以动态扩展新节点或调整流程。

2. **事件通信设计不统一**：
   - `ChatAgentServer` 和 `SearchAgentServer` 使用 `StreamChunkTransformer` 将 LangChain 的 stream 转换为自定义的 `ApiStreamChunk` 类型。
   - `DeepResearchAgentServer` 则直接 yield 原始 `state` 对象，在 API 路由层通过 `handleStateUpdate` 手动做 diff 比较来提取变更事件。
   - 前端 `StreamChatHandler` 需要针对不同模式（chat/search/deepResearch）做完全不同的数据处理逻辑。
   - 三种 Agent 的 SSE 事件格式不一致（`content` vs `state` vs 自定义 delta 类型）。

3. **与 LangChain 数据流脱节**：LangChain/LangGraph 提供了丰富的 streaming 模式（`messages`、`updates`、`values`、`events`），但当前项目未充分利用，尤其是 `events` 模式（`streamEvents` API）可以提供标准化的事件流，包含 `on_chain_start`、`on_llm_stream`、`on_tool_start` 等细粒度事件。

本次重构的目标是：将 Agent 架构从固定工作流改为灵活的事件驱动架构，建立统一的事件流协议，并充分契合 LangChain/LangGraph 的原生数据流能力。

---

## 需求

### 需求 1：统一事件协议层（Unified Event Protocol）

**用户故事：** 作为一名开发者，我希望所有 Agent（Chat、Search、DeepResearch）产生的输出都遵循统一的事件协议格式，以便前后端可以用同一套逻辑处理所有类型的 Agent 事件流。

#### 验收标准

1. WHEN 任意 Agent 产生输出 THEN 系统 SHALL 将其转换为统一的 `AgentEvent` 类型，包含以下标准字段：`eventType`（事件类型枚举）、`timestamp`、`agentId`、`payload`（事件数据）、`metadata`（可选的上下文信息）。
2. WHEN 定义事件类型枚举 THEN 系统 SHALL 至少包含以下事件类型：`llm_stream`（LLM 文本流）、`llm_complete`（LLM 完成）、`tool_call_start`（工具调用开始）、`tool_call_result`（工具调用结果）、`state_update`（状态变更）、`human_interrupt`（人工中断）、`error`（错误）、`lifecycle`（生命周期事件如 start/done）。
3. WHEN 现有的 `ApiStreamChunk` 类型被替换 THEN 系统 SHALL 保持向后兼容，确保前端现有的消息渲染逻辑可以平滑迁移。
4. IF 事件协议需要扩展新的事件类型 THEN 系统 SHALL 支持通过类型联合（Union Type）方式扩展，无需修改核心协议代码。

---

### 需求 2：基于 LangChain streamEvents 的事件流适配（Event Stream Adapter）

**用户故事：** 作为一名开发者，我希望 Agent 的事件流能直接利用 LangChain/LangGraph 的 `streamEvents` API，以便获得标准化的、细粒度的运行时事件，而不是手动做状态 diff。

#### 验收标准

1. WHEN Agent 执行时 THEN 系统 SHALL 优先使用 LangGraph 的 `streamEvents`（v2）API 来获取事件流，替代当前的 `stream` + 手动状态 diff 方式。
2. WHEN 接收到 LangChain 原生事件（如 `on_chat_model_stream`、`on_tool_start`、`on_chain_end` 等）THEN 系统 SHALL 通过 `EventStreamAdapter` 将其映射为需求 1 中定义的统一 `AgentEvent` 格式。
3. WHEN DeepResearch 工作流执行时 THEN 系统 SHALL 能够从 `streamEvents` 中捕获每个节点（supervisor、taskDecomposer 等）的进入/退出事件，替代当前基于 `curAction` 字段的手动状态追踪。
4. IF LangChain 的 `streamEvents` 不支持某些自定义事件（如 human interrupt）THEN 系统 SHALL 提供扩展机制，允许在事件流中注入自定义事件。
5. WHEN 使用 `streamEvents` THEN 系统 SHALL 支持通过 `include_tags`、`include_names` 等过滤参数来控制事件粒度，避免不必要的事件传输开销。

---

### 需求 3：灵活的 Agent 基类重构（Flexible Agent Base）

**用户故事：** 作为一名开发者，我希望 Agent 基类提供灵活的组合式能力（工具绑定、事件发射、状态管理），以便我可以快速构建不同类型的 Agent 而无需继承复杂的工作流逻辑。

#### 验收标准

1. WHEN 重构 `BaseAgentServer` THEN 系统 SHALL 将其改为基于组合模式（Composition）而非纯继承模式，核心能力（事件发射、流处理、工具管理）通过可插拔的模块提供。
2. WHEN 创建新的 Agent THEN 系统 SHALL 支持通过配置式声明（而非硬编码）来定义 Agent 的能力组合，例如：是否需要工具、是否需要状态持久化、使用哪种流模式。
3. WHEN Agent 需要发射事件 THEN 系统 SHALL 提供统一的 `emit(event: AgentEvent)` 方法，所有 Agent 通过该方法将事件推入统一事件流。
4. IF Agent 需要使用 LangGraph 的 StateGraph THEN 系统 SHALL 支持将 StateGraph 作为可选的执行引擎插入 Agent，而非强制所有 Agent 都使用 StateGraph。
5. WHEN `AgentManager` 管理 Agent 实例 THEN 系统 SHALL 支持动态注册/注销 Agent，并提供基于事件的 Agent 间通信能力（通过共享事件总线）。

---

### 需求 4：统一 SSE 传输层重构（Unified SSE Transport）

**用户故事：** 作为一名开发者，我希望后端到前端的 SSE 传输层能统一处理所有类型的 Agent 事件，以便消除当前三种 API 路由中重复的 SSE 构建逻辑。

#### 验收标准

1. WHEN 后端向前端推送事件 THEN 系统 SHALL 通过统一的 SSE 传输层将 `AgentEvent` 序列化为 SSE 格式，所有 API 路由共享同一套 SSE 构建逻辑。
2. WHEN 重构 API 路由 THEN 系统 SHALL 将当前的三个独立路由（`basic_agents`、`search_agents`、`deep_research`）合并为一个统一的 `/api/chat/v2` 路由，通过请求参数中的 `agentType` 字段来路由到不同的 Agent。
3. WHEN SSE 事件传输时 THEN 系统 SHALL 在每个事件中包含 `eventType` 字段，前端可以根据该字段进行统一的事件分发处理。
4. IF SSE 连接中断 THEN 系统 SHALL 支持事件重放机制（通过 `Last-Event-ID` 头），确保前端不会丢失关键状态事件。
5. WHEN 传输层处理错误事件 THEN 系统 SHALL 统一错误事件格式，包含 `errorCode`、`errorMessage`、`recoverable`（是否可恢复）字段。

---

### 需求 5：前端统一事件消费层重构（Unified Event Consumer）

**用户故事：** 作为一名前端开发者，我希望前端有一个统一的事件消费层来处理所有 Agent 的事件流，以便消除当前 `StreamChatHandler` 中针对不同模式的条件分支逻辑。

#### 验收标准

1. WHEN 前端接收 SSE 事件 THEN 系统 SHALL 通过统一的 `EventConsumer` 类解析所有事件，并根据 `eventType` 分发到对应的处理器（Handler）。
2. WHEN 处理 `llm_stream` 事件 THEN 系统 SHALL 将文本增量追加到当前消息内容中，与当前 chat/search 模式的文本流处理逻辑一致。
3. WHEN 处理 `state_update` 事件 THEN 系统 SHALL 根据 payload 中的具体状态类型（如 `tasks_initial`、`task_update`、`report` 等）更新对应的 Zustand store。
4. WHEN 处理 `human_interrupt` 事件 THEN 系统 SHALL 触发 UI 层的中断决策组件展示，与当前 `HumanDecision` 组件的交互逻辑一致。
5. IF 前端需要处理新的事件类型 THEN 系统 SHALL 支持通过注册新的事件处理器（Handler）来扩展，无需修改 `EventConsumer` 核心代码。
6. WHEN 重构 `StreamChatHandler` THEN 系统 SHALL 保留现有的 session 管理、消息持久化等业务逻辑，仅替换事件解析和分发部分。

---

### 需求 6：DeepResearch 工作流事件化改造（Workflow Event Integration）

**用户故事：** 作为一名开发者，我希望 DeepResearch 工作流的每个节点都能自然地发射标准事件，以便前端可以实时感知工作流的执行进度，而不依赖全量状态 diff。

#### 验收标准

1. WHEN DeepResearch 工作流中的任意节点开始执行 THEN 系统 SHALL 自动发射 `node_enter` 事件，包含节点名称和输入状态摘要。
2. WHEN DeepResearch 工作流中的任意节点完成执行 THEN 系统 SHALL 自动发射 `node_exit` 事件，包含节点名称和输出状态变更。
3. WHEN `taskHandler` 节点处理单个任务时 THEN 系统 SHALL 发射 `task_progress` 事件，包含当前任务 ID、状态变更和处理结果。
4. WHEN `reportGenerationAssitant` 节点生成报告时 THEN 系统 SHALL 支持流式发射报告内容（而非当前的一次性返回），使前端可以逐步渲染报告。
5. WHEN `humanDecision` 节点触发中断 THEN 系统 SHALL 发射 `human_interrupt` 事件，并在用户做出决策后发射 `human_resume` 事件。
6. IF 当前 `handleStateUpdate` 中的状态 diff 逻辑被替换 THEN 系统 SHALL 确保所有原有的前端状态更新行为（simpleAnalysis、tasks、report、interrupt）都能通过新的事件机制正确触发。

---

## 技术约束与边界

1. **技术栈约束**：项目基于 Next.js 14 + LangChain.js + LangGraph.js + Zustand，重构需在现有技术栈内完成。
2. **渐进式迁移**：重构应支持渐进式迁移，新旧 API 路由可以共存一段时间（v1 和 v2），避免一次性大规模破坏性变更。
3. **LangChain 版本兼容**：当前使用 `@langchain/langgraph@^1.0.2`，需确认 `streamEvents` v2 API 在该版本中的可用性和稳定性。
4. **性能考量**：`streamEvents` 会产生比 `stream` 更多的事件，需要在事件过滤和传输效率之间取得平衡。
5. **Checkpointer 兼容**：当前使用 PostgreSQL checkpointer 进行状态持久化，重构后需确保 checkpointer 机制不受影响。

## 成功标准

1. 所有三种 Agent（Chat、Search、DeepResearch）的事件输出格式统一。
2. 前端 `StreamChatHandler` 中不再有基于 `mode` 的条件分支。
3. DeepResearch 工作流的状态变更通过事件自然传播，`handleStateUpdate` 中的手动 diff 逻辑被消除。
4. 新增 Agent 类型时，只需定义 Agent 配置和事件处理器，无需修改核心框架代码。
5. 报告生成支持流式输出，前端可以逐步渲染。
