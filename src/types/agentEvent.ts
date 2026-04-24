/**
 * 统一事件协议类型系统
 *
 * 所有 Agent（Chat、Search、DeepResearch）产生的输出都遵循此统一事件协议格式，
 * 前后端可以用同一套逻辑处理所有类型的 Agent 事件流。
 */

/**
 * Agent 事件类型枚举
 * 通过 TypeScript 可辨识联合类型（Discriminated Union）实现类型安全
 */
export enum AgentEventType {
  /** LLM 文本流式输出 */
  LLM_STREAM = "llm_stream",
  /** LLM 输出完成 */
  LLM_COMPLETE = "llm_complete",
  /** 工具调用开始 */
  TOOL_CALL_START = "tool_call_start",
  /** 工具调用结果 */
  TOOL_CALL_RESULT = "tool_call_result",
  /** 状态变更 */
  STATE_UPDATE = "state_update",
  /** 人工中断 */
  HUMAN_INTERRUPT = "human_interrupt",
  /** 人工恢复 */
  HUMAN_RESUME = "human_resume",
  /** 错误 */
  ERROR = "error",
  /** 生命周期事件（start / done） */
  LIFECYCLE = "lifecycle",
  /** 工作流节点进入 */
  NODE_ENTER = "node_enter",
  /** 工作流节点退出 */
  NODE_EXIT = "node_exit",
  /** 任务进度更新 */
  TASK_PROGRESS = "task_progress",
  /** Sub-agent 调度事件 */
  SUB_AGENT_DISPATCH = "sub_agent_dispatch",
  /** Harness 生命周期事件 */
  HARNESS_LIFECYCLE = "harness_lifecycle",
}

/** LLM 流式文本 payload */
export interface LlmStreamPayload {
  /** 增量文本内容 */
  text: string;
  /** 可选的推理/思考文本 */
  reasoning?: string;
}

/** LLM 完成 payload */
export interface LlmCompletePayload {
  /** 完整的输出文本（可选，某些场景下不需要重复传输） */
  fullText?: string;
  /** token 使用统计 */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    totalCost?: number;
  };
}

/** 工具调用开始 payload */
export interface ToolCallStartPayload {
  /** 工具调用 ID */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 工具调用参数（JSON 字符串） */
  arguments?: string;
}

/** 工具调用结果 payload */
export interface ToolCallResultPayload {
  /** 工具调用 ID */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 工具返回结果 */
  result: any;
  /** 是否执行成功 */
  success: boolean;
  /** 错误信息（失败时） */
  errorMessage?: string;
}

/** 状态变更 payload */
export interface StateUpdatePayload {
  /** 状态变更的子类型，用于前端精确分发 */
  stateType:
    | "simple_analysis"
    | "tasks_initial"
    | "task_update"
    | "report"
    | "research_target"
    | "custom";
  /** 状态数据 */
  data: any;
}

/** 人工中断 payload */
export interface HumanInterruptPayload {
  /** 中断问题描述 */
  question: string;
  /** 中断详情 */
  details: any;
}

/** 人工恢复 payload */
export interface HumanResumePayload {
  /** 用户的决策结果 */
  decision: string;
  /** 恢复的目标节点 */
  resumeTarget?: string;
}

/** 错误 payload */
export interface ErrorPayload {
  /** 错误码 */
  errorCode: string;
  /** 错误信息 */
  errorMessage: string;
  /** 是否可恢复 */
  recoverable: boolean;
}

/** 生命周期 payload */
export interface LifecyclePayload {
  /** 生命周期阶段 */
  stage: "start" | "done";
  /** 时间戳 */
  timestamp: number;
}

/** 节点进入 payload */
export interface NodeEnterPayload {
  /** 节点名称 */
  nodeName: string;
  /** 输入状态摘要（可选） */
  inputSummary?: Record<string, any>;
}

/** 节点退出 payload */
export interface NodeExitPayload {
  /** 节点名称 */
  nodeName: string;
  /** 输出状态变更（可选） */
  outputDelta?: Record<string, any>;
}

/** 任务进度 payload */
export interface TaskProgressPayload {
  /** 任务 ID */
  taskId: string;
  /** 任务描述 */
  description?: string;
  /** 任务状态 */
  status: string;
  /** 是否需要搜索 */
  needSearch?: boolean;
  /** 搜索结果 */
  searchResult?: any[];
  /** 任务结果 */
  result?: string;
}

/** Sub-agent 调度 payload */
export interface SubAgentDispatchPayload {
  /** Sub-agent 名称 */
  subAgentName: string;
  /** 任务描述 */
  task: string;
  /** 调度状态 */
  status: "dispatched" | "running" | "completed" | "failed";
  /** 执行结果（完成时） */
  result?: string;
  /** 错误信息（失败时） */
  errorMessage?: string;
  /** 执行耗时（毫秒） */
  durationMs?: number;
}

/** Harness 生命周期 payload */
export interface HarnessLifecyclePayload {
  /** Harness 实例 ID */
  harnessId: string;
  /** 生命周期阶段 */
  phase: "initialize" | "execute" | "cleanup";
  /** 阶段状态 */
  status: "start" | "complete" | "error";
  /** 嵌套深度（0 = Lead Agent） */
  depth: number;
  /** 时间戳 */
  timestamp: number;
  /** 错误信息（error 状态时） */
  errorMessage?: string;
}

/** 事件元数据 */
export interface AgentEventMetadata {
  /** 会话 ID */
  sessionId?: string;
  /** 深度研究 ID */
  deepResearchId?: string;
  /** 其他自定义元数据 */
  [key: string]: any;
}

/** 基础事件字段 */
interface BaseAgentEvent {
  /** 事件时间戳 */
  timestamp: number;
  /** Agent 标识 */
  agentId: string;
  /** 可选的事件元数据 */
  metadata?: AgentEventMetadata;
}

/** LLM 流式事件 */
export interface LlmStreamEvent extends BaseAgentEvent {
  eventType: AgentEventType.LLM_STREAM;
  payload: LlmStreamPayload;
}

/** LLM 完成事件 */
export interface LlmCompleteEvent extends BaseAgentEvent {
  eventType: AgentEventType.LLM_COMPLETE;
  payload: LlmCompletePayload;
}

/** 工具调用开始事件 */
export interface ToolCallStartEvent extends BaseAgentEvent {
  eventType: AgentEventType.TOOL_CALL_START;
  payload: ToolCallStartPayload;
}

/** 工具调用结果事件 */
export interface ToolCallResultEvent extends BaseAgentEvent {
  eventType: AgentEventType.TOOL_CALL_RESULT;
  payload: ToolCallResultPayload;
}

/** 状态变更事件 */
export interface StateUpdateEvent extends BaseAgentEvent {
  eventType: AgentEventType.STATE_UPDATE;
  payload: StateUpdatePayload;
}

/** 人工中断事件 */
export interface HumanInterruptEvent extends BaseAgentEvent {
  eventType: AgentEventType.HUMAN_INTERRUPT;
  payload: HumanInterruptPayload;
}

/** 人工恢复事件 */
export interface HumanResumeEvent extends BaseAgentEvent {
  eventType: AgentEventType.HUMAN_RESUME;
  payload: HumanResumePayload;
}

/** 错误事件 */
export interface ErrorEvent extends BaseAgentEvent {
  eventType: AgentEventType.ERROR;
  payload: ErrorPayload;
}

/** 生命周期事件 */
export interface LifecycleEvent extends BaseAgentEvent {
  eventType: AgentEventType.LIFECYCLE;
  payload: LifecyclePayload;
}

/** 节点进入事件 */
export interface NodeEnterEvent extends BaseAgentEvent {
  eventType: AgentEventType.NODE_ENTER;
  payload: NodeEnterPayload;
}

/** 节点退出事件 */
export interface NodeExitEvent extends BaseAgentEvent {
  eventType: AgentEventType.NODE_EXIT;
  payload: NodeExitPayload;
}

/** 任务进度事件 */
export interface TaskProgressEvent extends BaseAgentEvent {
  eventType: AgentEventType.TASK_PROGRESS;
  payload: TaskProgressPayload;
}

/** Sub-agent 调度事件 */
export interface SubAgentDispatchEvent extends BaseAgentEvent {
  eventType: AgentEventType.SUB_AGENT_DISPATCH;
  payload: SubAgentDispatchPayload;
}

/** Harness 生命周期事件 */
export interface HarnessLifecycleEvent extends BaseAgentEvent {
  eventType: AgentEventType.HARNESS_LIFECYCLE;
  payload: HarnessLifecyclePayload;
}

/**
 * 统一 Agent 事件类型（可辨识联合类型）
 *
 * 通过 `eventType` 字段进行类型收窄：
 * ```ts
 * if (event.eventType === AgentEventType.LLM_STREAM) {
 *   // TypeScript 自动推断 event.payload 为 LlmStreamPayload
 *   console.log(event.payload.text);
 * }
 * ```
 *
 * 扩展新事件类型时，只需：
 * 1. 在 AgentEventType 枚举中添加新值
 * 2. 定义新的 Payload 接口
 * 3. 定义新的 Event 接口（extends BaseAgentEvent）
 * 4. 将新 Event 接口添加到此联合类型中
 */
export type AgentEvent =
  | LlmStreamEvent
  | LlmCompleteEvent
  | ToolCallStartEvent
  | ToolCallResultEvent
  | StateUpdateEvent
  | HumanInterruptEvent
  | HumanResumeEvent
  | ErrorEvent
  | LifecycleEvent
  | NodeEnterEvent
  | NodeExitEvent
  | TaskProgressEvent
  | SubAgentDispatchEvent
  | HarnessLifecycleEvent;

/** Agent 事件流类型 */
export type AgentEventStream = AsyncGenerator<AgentEvent>;

/**
 * 创建 AgentEvent 的工厂函数
 * @param eventType 事件类型
 * @param agentId Agent 标识
 * @param payload 事件数据
 * @param metadata 可选元数据
 */
export function createAgentEvent<T extends AgentEvent>(
  eventType: T["eventType"],
  agentId: string,
  payload: T["payload"],
  metadata?: AgentEventMetadata,
): T {
  return {
    eventType,
    timestamp: Date.now(),
    agentId,
    payload,
    metadata,
  } as T;
}
