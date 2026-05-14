/** 客户端事件类型枚举 */
export enum ClientAgentEventType {
  START = 'start',
  STREAM_CHUNK = 'stream_chunk',
  TOOL_CALL = 'tool_call',
  TOOL_RESULT = 'tool_result',
  STATE_UPDATE = 'state_update',
  TASK_PROGRESS = 'task_progress',
  HUMAN_INTERRUPT = 'human_interrupt',
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
  | ToolCallEvent
  | ToolResultEvent
  | StateUpdateEvent
  | TaskProgressEvent
  | HumanInterruptEvent
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
