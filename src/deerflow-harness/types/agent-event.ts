/** 事件类型 */
export enum AgentEventType {
  /** LLM 文本流式输出 */
  LLM_STREAM = 'llm_stream',
  /** LLM 输出完成 */
  LLM_COMPLETE = 'llm_complete',
  /** 工具调用开始 */
  TOOL_CALL_START = 'tool_call_start',
  /** 工具调用结果 */
  TOOL_CALL_RESULT = 'tool_call_result',
  /** 状态变更 */
  STATE_UPDATE = 'state_update',
  /** 人工中断 */
  HUMAN_INTERRUPT = 'human_interrupt',
  /** 人工恢复 */
  HUMAN_RESUME = 'human_resume',
  /** 错误 */
  ERROR = 'error',
  /** 生命周期事件（start / done） */
  LIFECYCLE = 'lifecycle',
  /** 工作流节点进入 */
  NODE_ENTER = 'node_enter',
  /** 工作流节点退出 */
  NODE_EXIT = 'node_exit',
  /** 任务进度更新 */
  TASK_PROGRESS = 'task_progress',
  /** Sub-agent 调度事件 */
  SUB_AGENT_DISPATCH = 'sub_agent_dispatch',
  /** Harness 生命周期事件 */
  HARNESS_LIFECYCLE = 'harness_lifecycle',
  /** Subagent task 已启动 */
  TASK_STARTED = 'task_started',
  /** Subagent task 运行中（每条 AI 消息一次） */
  TASK_RUNNING = 'task_running',
  /** Subagent task 已成功完成 */
  TASK_COMPLETED = 'task_completed',
  /** Subagent task 执行失败 */
  TASK_FAILED = 'task_failed',
  /** Subagent task 被取消 */
  TASK_CANCELLED = 'task_cancelled',
  /** Subagent task 超时 */
  TASK_TIMED_OUT = 'task_timed_out',
}

/** LLM 流式文本 payload */
export interface LlmStreamPayload {
  /** 增量正文内容（最终答案）；纯推理时省略 */
  text?: string;
  /** 推理/思考文本（含 tool_calls 时的 planning 文本） */
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
    | 'simple_analysis'
    | 'tasks_initial'
    | 'task_update'
    | 'report'
    | 'research_target'
    | 'custom';
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
  stage: 'start' | 'done';
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
  /** subagent 内部工具调用 ID（status='tool_call' / 'tool_result' 时） */
  toolCallId?: string;
  /** subagent 内部工具名（status='tool_call' / 'tool_result' 时） */
  toolName?: string;
  /** subagent 内部 tool_call 的入参（JSON 字符串） */
  arguments?: string;
  /** subagent 内部 tool_result 的结果 */
  toolResult?: any;
  /** subagent 内部 tool_result 的成功标志 */
  toolSuccess?: boolean;
  /** subagent 内部 tool_result 的错误文案 */
  toolErrorMessage?: string;
}

/** Sub-agent 调度 payload */
export interface SubAgentDispatchPayload {
  /** Sub-agent 名称 */
  subAgentName: string;
  /** 任务描述 */
  task: string;
  /** 调度状态 */
  status: 'dispatched' | 'running' | 'completed' | 'failed';
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
  phase: 'initialize' | 'execute' | 'cleanup';
  /** 阶段状态 */
  status: 'start' | 'complete' | 'error';
  /** 嵌套深度（0 = Lead Agent） */
  depth: number;
  /** 时间戳 */
  timestamp: number;
  /** 错误信息（error 状态时） */
  errorMessage?: string;
}

/** Subagent task 启动 payload */
export interface TaskStartedPayload {
  /** Task 唯一 ID（建议用 tool_call_id 或 traceId） */
  taskId: string;
  /** 任务简短描述（lead agent 调用时透传） */
  description?: string;
  /** subagent 类型名 */
  subagentType?: string;
}

/** Subagent task 运行中（增量 AI 消息）payload */
export interface TaskRunningPayload {
  taskId: string;
  /** 当前增量 AI 消息（结构化 JSON，前端可按需展示） */
  message: any;
  /** 当前是第几条（从 1 开始） */
  messageIndex: number;
  /** 截至目前累计的消息数 */
  totalMessages: number;
  /** 含 tool_calls 时的 planning 文本，归入 timeline reasoning */
  reasoning?: string;
}

/** Subagent task 完成 payload */
export interface TaskCompletedPayload {
  taskId: string;
  /** 文本结果（subagent 最终输出）；可能为 null */
  result: string | null;
  /** 结构化报告 JSON（来自 final-report fenced block 解析）；可能为 null */
  structured?: unknown;
}

/** Subagent task 失败 payload */
export interface TaskFailedPayload {
  taskId: string;
  /** 错误描述 */
  error: string | null;
}

/** Subagent task 取消 payload */
export interface TaskCancelledPayload {
  taskId: string;
  /** 取消原因（可选） */
  error?: string | null;
}

/** Subagent task 超时 payload */
export interface TaskTimedOutPayload {
  taskId: string;
  /** 错误描述（可选） */
  error?: string | null;
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

/** Subagent task 启动事件 */
export interface TaskStartedEvent extends BaseAgentEvent {
  eventType: AgentEventType.TASK_STARTED;
  payload: TaskStartedPayload;
}

/** Subagent task 运行中事件 */
export interface TaskRunningEvent extends BaseAgentEvent {
  eventType: AgentEventType.TASK_RUNNING;
  payload: TaskRunningPayload;
}

/** Subagent task 完成事件 */
export interface TaskCompletedEvent extends BaseAgentEvent {
  eventType: AgentEventType.TASK_COMPLETED;
  payload: TaskCompletedPayload;
}

/** Subagent task 失败事件 */
export interface TaskFailedEvent extends BaseAgentEvent {
  eventType: AgentEventType.TASK_FAILED;
  payload: TaskFailedPayload;
}

/** Subagent task 取消事件 */
export interface TaskCancelledEvent extends BaseAgentEvent {
  eventType: AgentEventType.TASK_CANCELLED;
  payload: TaskCancelledPayload;
}

/** Subagent task 超时事件 */
export interface TaskTimedOutEvent extends BaseAgentEvent {
  eventType: AgentEventType.TASK_TIMED_OUT;
  payload: TaskTimedOutPayload;
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
  | HarnessLifecycleEvent
  | TaskStartedEvent
  | TaskRunningEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskCancelledEvent
  | TaskTimedOutEvent;

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
  eventType: T['eventType'],
  agentId: string,
  payload: T['payload'],
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
