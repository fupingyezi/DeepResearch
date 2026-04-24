# 需求文档：Agent Harness 架构重构

## 引言

当前项目采用固定角色的 Multi-Agent 图架构（基于 LangGraph StateGraph），包含 6 个硬编码节点（supervisor、simpleAnalyser、taskDecomposer、taskHandler、reportGenerationAssitant、humanDecision），通过 supervisor 节点的条件判断进行路由。这种架构存在**角色固化**问题——想新增一个"设计师 Agent"或"运维 Agent"，需要修改图结构、添加节点、调整边，扩展性差。

本次重构包含两个核心目标：

### 目标一：构建 Agent Harness 运行时

**Harness（线束/容器）** 是 Agent 的运行时外壳，负责为 Agent 提供标准化的执行环境。类似于测试框架中的 Test Harness，Agent Harness 为每个 Agent（无论是 Lead Agent 还是 Sub-agent）提供：

- **标准化生命周期管理**：初始化 → 执行 → 清理，带有 Hooks 钩子
- **上下文隔离**：每个 Agent 运行在独立的上下文窗口中，不污染其他 Agent 的状态
- **工具沙箱**：每个 Agent 只能访问其被授权的工具集
- **统一的输入/输出协议**：标准化的消息格式和结果返回格式
- **可观测性**：自动采集执行指标、事件流、错误信息

### 目标二：从固定图到动态调度

将架构从**固定角色的 Multi-Agent 图**转变为 **单一 Lead Agent + 中间件链 + 动态 Sub-agent** 模式：

- **简单任务**：Lead Agent 直接处理（`__start__` → `agent` → `tools` / `__end__`）
- **复杂任务**：Lead Agent 作为调度者，动态创建并分发 Sub-agent，每个 Sub-agent 在独立 Harness 中执行后将结果返回 Lead Agent

![架构示意图](https://zhiyan-ai-agent-with-1258344702.cos.ap-guangzhou.tencentcos.cn/copilot/54a32bec-e3c3-44cf-8514-b24fbc92016d/image-019db9ba52e27ee59be02835b786708e.png)

### 现有架构 vs 目标架构

```
现有架构（StateGraph 固定图）：
START → supervisor → [simpleAnalyser | taskDecomposer | taskHandler | reportGenerationAssitant | __end__]
         ↑                                    ↓
         ←──── 各节点执行完毕后回到 supervisor ────

目标架构（Harness + 动态调度）：
┌─────────────────────────────────────────────────────────┐
│                    Agent Harness Runtime                 │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Lead Agent Harness                    │  │
│  │  ┌─────────┐  ┌──────────┐  ┌─────────────────┐  │  │
│  │  │ Hooks   │→ │ Agent    │→ │ Tools / Dispatch│  │  │
│  │  │(pre/post)│  │ (LLM)   │  │ (含 sub-agent)  │  │  │
│  │  └─────────┘  └──────────┘  └─────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
│       ↓ dispatch_sub_agent(name, task)                   │
│  ┌──────────────┐  ┌──────────────┐                     │
│  │ Sub-agent A  │  │ Sub-agent B  │  ...                │
│  │  Harness     │  │  Harness     │                     │
│  │ ┌──────────┐ │  │ ┌──────────┐ │                     │
│  │ │Agent+Tool│ │  │ │Agent+Tool│ │                     │
│  │ └──────────┘ │  │ └──────────┘ │                     │
│  └──────────────┘  └──────────────┘                     │
└─────────────────────────────────────────────────────────┘
```

---

## 需求

### 需求 1：Agent Harness 运行时容器

**用户故事：** 作为一名开发者，我希望有一个标准化的 Agent Harness 运行时容器，以便每个 Agent（Lead 或 Sub-agent）都能在统一的、隔离的环境中执行，而无需关心底层基础设施。

#### 验收标准

1. WHEN 系统创建一个 Agent 实例时 THEN Harness SHALL 为该 Agent 分配独立的执行上下文（包括独立的 system prompt、tools 绑定、状态存储），确保不同 Agent 之间的上下文完全隔离
2. WHEN Agent 在 Harness 中执行时 THEN Harness SHALL 提供标准化的生命周期管理：`initialize` → `execute` → `cleanup`，每个阶段都可通过 Hooks 进行扩展
3. WHEN Agent 尝试调用工具时 THEN Harness SHALL 仅允许该 Agent 访问其配置中声明的工具集（工具沙箱），拒绝未授权的工具调用
4. WHEN Agent 执行过程中产生事件时 THEN Harness SHALL 自动采集并转发这些事件到统一的事件流，包括执行指标（耗时、token 用量）、LLM 流式输出、工具调用记录
5. WHEN Agent 执行完毕或异常退出时 THEN Harness SHALL 自动执行清理逻辑，释放资源，并确保不会泄漏到其他 Agent 的上下文中
6. IF Harness 检测到 Agent 执行超时 THEN Harness SHALL 强制终止该 Agent 并发出超时错误事件，超时时间应可通过配置指定

### 需求 2：Harness Hooks 生命周期钩子系统

**用户故事：** 作为一名开发者，我希望能在 Agent 执行的关键节点插入自定义逻辑（Hooks），以便实现日志记录、权限校验、上下文注入等横切关注点，而无需修改 Agent 本身的代码。

#### 验收标准

1. WHEN Agent 开始执行前 THEN Harness SHALL 触发 `preExecute` Hook，允许注入额外上下文、修改输入、或阻止执行
2. WHEN Agent 即将调用工具前 THEN Harness SHALL 触发 `preToolUse` Hook，允许校验工具参数、修改工具输入、或拒绝工具调用
3. WHEN Agent 工具调用完成后 THEN Harness SHALL 触发 `postToolUse` Hook，允许对工具输出进行后处理、记录日志、或触发后续操作
4. WHEN Agent 执行完成后 THEN Harness SHALL 触发 `postExecute` Hook，允许对最终结果进行校验、格式化、或触发清理逻辑
5. WHEN 开发者注册 Hook 时 THEN 系统 SHALL 支持指定 Hook 的作用范围（全局所有 Agent / 特定 Agent 类型 / 特定 Agent 实例）和执行优先级
6. IF 某个 Hook 执行失败 THEN Harness SHALL 根据 Hook 配置决定是跳过继续执行还是中断整个 Agent 执行，并发出错误事件

### 需求 3：Sub-agent 工具化调度机制

**用户故事：** 作为一名开发者，我希望 Lead Agent 能像调用工具一样调度 Sub-agent（即 Sub-agent 对 Lead Agent 来说就是一个特殊的 "tool"），以便 Lead Agent 可以通过 LLM 的 function calling 能力自主决定何时、调用哪个 Sub-agent。

#### 验收标准

1. WHEN 系统注册一个 Sub-agent 配置时 THEN 系统 SHALL 自动将该 Sub-agent 包装为一个 LangChain Tool（包含 name、description、input schema），并注入到 Lead Agent 的工具列表中
2. WHEN Lead Agent 的 LLM 决定调用某个 Sub-agent Tool 时 THEN 系统 SHALL 在独立的 Harness 中实例化该 Sub-agent，传入任务描述，并等待其执行完成后将结果返回给 Lead Agent
3. WHEN Sub-agent 在独立 Harness 中执行时 THEN Sub-agent SHALL 拥有自己的 ReAct 循环（`__start__` → `agent` → `tools` / `__end__`），能够自主决定是否调用工具、调用哪个工具
4. WHEN Sub-agent 执行完成后 THEN 系统 SHALL 将 Sub-agent 的最终输出作为 Tool Result 返回给 Lead Agent，Lead Agent 可基于此结果继续推理
5. IF Lead Agent 的 LLM 判断任务简单不需要 Sub-agent THEN Lead Agent SHALL 直接使用自身绑定的基础工具（如 search_web）完成任务，不创建任何 Sub-agent
6. WHEN 多个 Sub-agent 被调度时 THEN 系统 SHALL 支持 Lead Agent 通过多次 tool call 串行调度，或通过 parallel tool calls 并行调度无依赖关系的 Sub-agent

### 需求 4：Sub-agent 声明式配置与注册表

**用户故事：** 作为一名开发者，我希望能通过声明式配置文件定义 Sub-agent，以便新增一个 Sub-agent 只需添加一个配置，无需修改核心代码或图结构。

#### 验收标准

1. WHEN 开发者创建一个 Sub-agent 配置文件时 THEN 系统 SHALL 支持以下配置字段：
   - `name`：Sub-agent 唯一标识（必选）
   - `description`：Sub-agent 用途描述，用于 Lead Agent 的 LLM 判断调用时机（必选）
   - `systemPrompt`：Sub-agent 执行时的系统提示词（必选）
   - `model`：Sub-agent 使用的 LLM 模型配置（可选，默认继承 Lead Agent）
   - `tools`：Sub-agent 可使用的工具列表（可选）
   - `timeout`：执行超时时间（可选，默认 60 秒）
   - `hooks`：该 Sub-agent 专属的 Hooks 配置（可选）
2. WHEN 系统启动时 THEN 系统 SHALL 自动扫描并加载所有 Sub-agent 配置文件，注册到 Sub-agent 注册表中
3. WHEN 注册表中的 Sub-agent 配置发生变化时 THEN 系统 SHALL 支持热加载，无需重启服务即可生效
4. IF 注册表中不存在 Lead Agent 请求的 Sub-agent THEN 系统 SHALL 使用默认的通用 Sub-agent 处理任务，并在日志中记录警告
5. WHEN 现有的 `simpleAnalyser`、`taskDecomposer`、`taskHandler`、`reportGenerationAssitant` 功能被迁移后 THEN 系统 SHALL 将它们重构为 Sub-agent 配置文件，每个配置文件包含对应的 systemPrompt 和 tools

### 需求 5：Lead Agent 核心引擎

**用户故事：** 作为一名开发者，我希望有一个统一的 Lead Agent 作为所有任务的入口和调度中心，以便无需修改图结构即可灵活处理简单和复杂任务。

#### 验收标准

1. WHEN 用户提交一个任务请求 THEN Lead Agent SHALL 在自己的 Harness 中接收该请求，其工具列表包含基础工具（如 search_web）和所有已注册的 Sub-agent Tool
2. WHEN Lead Agent 的 LLM 进行推理时 THEN Lead Agent SHALL 通过 ReAct 模式自主决定：直接回答、调用基础工具、或调度 Sub-agent，无需硬编码的 if-else 路由逻辑
3. WHEN Lead Agent 调度 Sub-agent 完成子任务后 THEN Lead Agent SHALL 基于 Sub-agent 返回的结果继续推理，决定是否需要调度更多 Sub-agent 或生成最终结果
4. WHEN Lead Agent 完成所有推理后 THEN Lead Agent SHALL 生成最终结果并返回给调用方
5. WHEN Lead Agent 运行时 THEN 系统 SHALL 保持与现有 `BaseAgentServer` 和 `AgentEventStream` 的兼容性，继续产出统一的 `AgentEvent` 事件流

### 需求 6：替换现有 Supervisor 路由逻辑

**用户故事：** 作为一名开发者，我希望用 Lead Agent 的 LLM 驱动路由替代现有的 supervisor 硬编码条件判断，以便路由决策更灵活、更易扩展。

#### 验收标准

1. WHEN Lead Agent 进行任务路由时 THEN 系统 SHALL 使用 LLM 的 function calling 能力（而非硬编码 if-else）来决定调用哪个 Sub-agent Tool
2. WHEN 现有的 `simpleAnalyser`、`taskDecomposer`、`taskHandler`、`reportGenerationAssitant` 功能被迁移后 THEN 系统 SHALL 将它们重构为可注册的 Sub-agent 配置
3. WHEN `humanDecision` 节点的功能被迁移后 THEN 系统 SHALL 将人工审核作为 Harness Hooks 中的一个可选 `preExecute` Hook 实现（在 Sub-agent 执行前触发人工确认）
4. WHEN 迁移完成后 THEN 系统 SHALL 保持与现有前端事件消费逻辑的兼容性，确保 `state_update`、`task_progress`、`human_interrupt` 等自定义事件格式不变
5. WHEN 迁移完成后 THEN 系统 SHALL 删除或标记废弃旧的 `deepResearchWorkFlow` 目录下的固定图实现

### 需求 7：状态管理与事件流兼容

**用户故事：** 作为一名开发者，我希望重构后的架构能保持与现有前端事件消费机制的兼容，以便前端代码无需大幅修改。

#### 验收标准

1. WHEN Lead Agent 或 Sub-agent 在 Harness 中产生事件时 THEN 系统 SHALL 继续使用现有的 `AgentEvent` 类型体系（`LifecycleEvent`、`ErrorEvent`、`HumanResumeEvent` 等）
2. WHEN Sub-agent 执行进度更新时 THEN 系统 SHALL 通过 `dispatchCustomEvent` 发出与现有格式兼容的 `state_update` 和 `task_progress` 事件
3. WHEN 系统使用 LangGraph 的 `streamEvents` API 时 THEN 系统 SHALL 通过现有的 `StreamProcessor` 模块处理事件流，或提供兼容的替代方案
4. WHEN 重构完成后 THEN 系统 SHALL 保持 `DeepResearchAgentServer.createMessage()` 方法的接口签名不变，确保 API 路由层无需修改
5. IF 新架构引入了新的事件类型（如 `SubAgentDispatchEvent`、`HarnessLifecycleEvent`） THEN 系统 SHALL 在 `AgentEventType` 枚举中扩展定义，并确保 `EventStreamAdapter` 能正确处理

### 需求 8：AgentManager 适配

**用户故事：** 作为一名开发者，我希望 `AgentManager` 能适配新的 Harness 架构，以便统一管理 Lead Agent 和 Sub-agent 的注册与获取。

#### 验收标准

1. WHEN 系统初始化时 THEN `AgentManager` SHALL 支持注册 Lead Agent（运行在 Harness 中的顶层 Agent）和 Sub-agent 配置（供 Lead Agent 动态调度）
2. WHEN 开发者通过 `AgentManager` 获取 Agent 时 THEN 系统 SHALL 区分获取 Lead Agent（用于处理用户请求）和获取 Sub-agent 注册表（用于 Lead Agent 内部查询可用的 Sub-agent）
3. WHEN 新的 Sub-agent 配置被注册到 `AgentManager` 时 THEN 系统 SHALL 自动将其包装为 Tool 并同步到 Lead Agent 的工具列表中
4. WHEN 重构完成后 THEN `AgentManager` SHALL 保持向后兼容，现有的 `AgentType` 枚举和 `getAgent()` 方法继续可用

---

## 技术约束与边界条件

### 技术栈约束
- 继续使用 LangGraph（`@langchain/langgraph`）作为底层执行引擎
- 继续使用 TypeScript 作为开发语言
- 保持与现有 Next.js API 路由的兼容性
- Sub-agent 的工具化包装基于 LangChain 的 `DynamicStructuredTool` 或 `tool()` API

### Harness 配置约束
- 单个 Agent Harness 的执行超时时间应可配置（默认 60 秒）
- Sub-agent 的最大并发数应可配置，防止资源耗尽（默认 5）
- Hooks 链的最大深度应有限制（建议不超过 10 层）
- Lead Agent 的 ReAct 循环最大迭代次数应可配置（默认 20 次）

### 边界条件
- Lead Agent 的 LLM 评估不可用时，应有降级策略（默认走通用 Sub-agent 路径）
- Sub-agent 嵌套调度深度应有限制（建议不超过 2 层，即 Sub-agent 不可再调度 Sub-agent）
- Harness 的上下文隔离应确保 Sub-agent 无法读取 Lead Agent 的完整状态，只能获取 Lead Agent 显式传递的任务描述

### 成功标准
1. 新增一个 Sub-agent 类型只需添加一个配置文件，无需修改图结构或核心代码
2. 现有的深度研究（Deep Research）功能在重构后行为不变，前端无感知
3. 系统启动时间不因架构变更而显著增加（< 20% 增幅）
4. 所有现有 API 端点保持向后兼容
5. Agent Harness 能正确隔离不同 Agent 的上下文，Sub-agent 执行不会污染 Lead Agent 的状态
