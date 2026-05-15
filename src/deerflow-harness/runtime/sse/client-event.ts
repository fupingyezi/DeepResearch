/** 客户端事件类型枚举 */
export enum ClientAgentEventType {
  START = 'start',
  STREAM_CHUNK = 'stream_chunk',
  LLM_COMPLETE = 'llm_complete',
  TOOL_CALL = 'tool_call',
  TOOL_RESULT = 'tool_result',
  STATE_UPDATE = 'state_update',
  TASK_PROGRESS = 'task_progress',
  HUMAN_INTERRUPT = 'human_interrupt',
  HUMAN_RESUME = 'human_resume',
  NODE_ENTER = 'node_enter',
  NODE_EXIT = 'node_exit',
  SUB_AGENT_DISPATCH = 'sub_agent_dispatch',
  HARNESS_LIFECYCLE = 'harness_lifecycle',
  TASK_STARTED = 'task_started',
  TASK_RUNNING = 'task_running',
  TASK_COMPLETED = 'task_completed',
  TASK_FAILED = 'task_failed',
  TASK_CANCELLED = 'task_cancelled',
  TASK_TIMED_OUT = 'task_timed_out',
  ERROR = 'error',
  END = 'end',
  HEARTBEAT = 'heartbeat',
}

export interface StartPayload {
  sessionId?: string;
}

export interface StreamChunkPayload {
  text: string;
  reasoning?: string;
}

export interface ToolCallPayload {
  toolCallId: string;
  toolName: string;
  arguments?: string;
}

export interface ToolResultPayload {
  toolCallId: string;
  toolName: string;
  result: unknown;
  success: boolean;
  errorMessage?: string;
}

export interface StateUpdatePayload {
  stateType:
    | 'simple_analysis'
    | 'tasks_initial'
    | 'task_update'
    | 'report'
    | 'research_target'
    | 'custom';
  data: unknown;
}

export interface TaskProgressPayload {
  taskId: string;
  status: string;
  description?: string;
  needSearch?: boolean;
  searchResult?: unknown[];
  result?: string;
  [k: string]: unknown;
}

export interface HumanInterruptPayload {
  question: string;
  details: unknown;
}

export interface ErrorPayload {
  errorCode: string;
  errorMessage: string;
  recoverable: boolean;
}

export interface LlmCompletePayload {
  fullText?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    totalCost?: number;
  };
}

export interface HumanResumePayload {
  decision: string;
  resumeTarget?: string;
}

export interface NodeEnterPayload {
  nodeName: string;
  inputSummary?: Record<string, unknown>;
}

export interface NodeExitPayload {
  nodeName: string;
  outputDelta?: Record<string, unknown>;
}

export interface SubAgentDispatchPayload {
  subAgentName: string;
  task: string;
  status: 'dispatched' | 'running' | 'completed' | 'failed';
  result?: string;
  errorMessage?: string;
  durationMs?: number;
}

export interface HarnessLifecyclePayload {
  harnessId: string;
  phase: 'initialize' | 'execute' | 'cleanup';
  status: 'start' | 'complete' | 'error';
  depth: number;
  timestamp: number;
  errorMessage?: string;
}

export interface TaskStartedClientPayload {
  taskId: string;
  description?: string;
  subagentType?: string;
}
export interface TaskRunningClientPayload {
  taskId: string;
  message: unknown;
  messageIndex: number;
  totalMessages: number;
}
export interface TaskCompletedClientPayload {
  taskId: string;
  result: string | null;
}
export interface TaskFailedClientPayload {
  taskId: string;
  error: string | null;
}
export interface TaskCancelledClientPayload {
  taskId: string;
  error?: string | null;
}
export interface TaskTimedOutClientPayload {
  taskId: string;
  error?: string | null;
}

export type EndPayload = Record<string, never>;
export type HeartbeatPayload = Record<string, never>;

interface BaseClientAgentEvent {
  timestamp: number;
  agentId: string;
}

export interface StartEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.START;
  payload: StartPayload;
}
export interface StreamChunkEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.STREAM_CHUNK;
  payload: StreamChunkPayload;
}
export interface LlmCompleteEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.LLM_COMPLETE;
  payload: LlmCompletePayload;
}
export interface ToolCallEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.TOOL_CALL;
  payload: ToolCallPayload;
}
export interface ToolResultEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.TOOL_RESULT;
  payload: ToolResultPayload;
}
export interface StateUpdateEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.STATE_UPDATE;
  payload: StateUpdatePayload;
}
export interface TaskProgressEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.TASK_PROGRESS;
  payload: TaskProgressPayload;
}
export interface HumanInterruptEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.HUMAN_INTERRUPT;
  payload: HumanInterruptPayload;
}
export interface HumanResumeEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.HUMAN_RESUME;
  payload: HumanResumePayload;
}
export interface NodeEnterEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.NODE_ENTER;
  payload: NodeEnterPayload;
}
export interface NodeExitEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.NODE_EXIT;
  payload: NodeExitPayload;
}
export interface SubAgentDispatchEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.SUB_AGENT_DISPATCH;
  payload: SubAgentDispatchPayload;
}
export interface HarnessLifecycleEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.HARNESS_LIFECYCLE;
  payload: HarnessLifecyclePayload;
}
export interface TaskStartedClientEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.TASK_STARTED;
  payload: TaskStartedClientPayload;
}
export interface TaskRunningClientEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.TASK_RUNNING;
  payload: TaskRunningClientPayload;
}
export interface TaskCompletedClientEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.TASK_COMPLETED;
  payload: TaskCompletedClientPayload;
}
export interface TaskFailedClientEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.TASK_FAILED;
  payload: TaskFailedClientPayload;
}
export interface TaskCancelledClientEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.TASK_CANCELLED;
  payload: TaskCancelledClientPayload;
}
export interface TaskTimedOutClientEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.TASK_TIMED_OUT;
  payload: TaskTimedOutClientPayload;
}
export interface ErrorEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.ERROR;
  payload: ErrorPayload;
}
export interface EndEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.END;
  payload: EndPayload;
}
export interface HeartbeatEvent extends BaseClientAgentEvent {
  eventType: ClientAgentEventType.HEARTBEAT;
  payload: HeartbeatPayload;
}

/** 客户端事件联合类型 */
export type ClientAgentEvent =
  | StartEvent
  | StreamChunkEvent
  | LlmCompleteEvent
  | ToolCallEvent
  | ToolResultEvent
  | StateUpdateEvent
  | TaskProgressEvent
  | HumanInterruptEvent
  | HumanResumeEvent
  | NodeEnterEvent
  | NodeExitEvent
  | SubAgentDispatchEvent
  | HarnessLifecycleEvent
  | TaskStartedClientEvent
  | TaskRunningClientEvent
  | TaskCompletedClientEvent
  | TaskFailedClientEvent
  | TaskCancelledClientEvent
  | TaskTimedOutClientEvent
  | ErrorEvent
  | EndEvent
  | HeartbeatEvent;

/** 客户端事件流 */
export type ClientAgentEventStream = AsyncGenerator<ClientAgentEvent>;

/**
 * 创建 ClientAgentEvent 工厂（后端版）
 *
 * 自动填充 timestamp。
 */
export function createClientAgentEvent<T extends ClientAgentEventType>(
  eventType: T,
  agentId: string,
  payload: Extract<ClientAgentEvent, { eventType: T }>['payload'],
): Extract<ClientAgentEvent, { eventType: T }> {
  return {
    eventType,
    timestamp: Date.now(),
    agentId,
    payload,
  } as Extract<ClientAgentEvent, { eventType: T }>;
}
