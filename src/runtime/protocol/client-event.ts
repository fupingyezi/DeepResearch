/**
 * 前端客户端事件协议（ClientAgentEvent）
 *
 * 这是前端独占的对外事件子集，与后端
 * `src/deerflow-harness/runtime/sse/client-event.ts` 字符串值与字段严格镜像，
 * 但物理独立、零 import 关系，仅通过 SSE 线协议保持兼容。
 *
 * 命名约定：
 * - 后端 internal 全集使用 `AgentEvent / AgentEventType / createAgentEvent`
 * - 前端客户端协议使用 `ClientAgentEvent / ClientAgentEventType / createClientAgentEvent`
 */

/** 客户端事件类型枚举（10 个值） */
export enum ClientAgentEventType {
  /** 流式会话开始 */
  START = "start",
  /** LLM 增量文本块 */
  STREAM_CHUNK = "stream_chunk",
  /** 工具调用开始 */
  TOOL_CALL = "tool_call",
  /** 工具调用结果 */
  TOOL_RESULT = "tool_result",
  /** 状态变更（DeepResearch 等场景） */
  STATE_UPDATE = "state_update",
  /** 任务进度更新 */
  TASK_PROGRESS = "task_progress",
  /** 人工中断（等待决策） */
  HUMAN_INTERRUPT = "human_interrupt",
  /** 错误 */
  ERROR = "error",
  /** 流式会话结束 */
  END = "end",
  /** 心跳（其余内部事件降级保活） */
  HEARTBEAT = "heartbeat",
}

/** ----- payload 接口 ----- */

export interface StartPayload {
  sessionId?: string;
}

export interface StreamChunkPayload {
  /** 增量文本 */
  text: string;
  /** 可选推理/思考文本 */
  reasoning?: string;
}

export interface ToolCallPayload {
  toolCallId: string;
  toolName: string;
  /** 工具入参（已序列化为 JSON 字符串） */
  arguments?: string;
}

export interface ToolResultPayload {
  toolCallId: string;
  toolName: string;
  /** 工具返回结果 */
  result: unknown;
  success: boolean;
  errorMessage?: string;
}

export interface StateUpdatePayload {
  /** 状态子类型，供前端按需分发 */
  stateType:
    | "simple_analysis"
    | "tasks_initial"
    | "task_update"
    | "report"
    | "research_target"
    | "custom";
  data: unknown;
}

export interface TaskProgressPayload {
  taskId: string;
  status: string;
  description?: string;
  needSearch?: boolean;
  searchResult?: unknown[];
  result?: string;
  /** 兼容扩展字段 */
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

/** END / HEARTBEAT 不携带业务字段 */
export type EndPayload = Record<string, never>;
export type HeartbeatPayload = Record<string, never>;

/** ----- 基础字段 ----- */

interface BaseClientAgentEvent {
  /** 事件时间戳（毫秒） */
  timestamp: number;
  /** Agent 标识（lead / sub-agent name 等） */
  agentId: string;
}

/** ----- 各事件接口（discriminated union 成员） ----- */

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

/**
 * 客户端事件联合类型（discriminated union）
 *
 * 通过 `eventType` 字段进行类型收窄：
 * ```ts
 * if (event.eventType === ClientAgentEventType.STREAM_CHUNK) {
 *   // event.payload 自动收窄为 StreamChunkPayload
 *   console.log(event.payload.text);
 * }
 * ```
 */
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

/** 客户端事件流（async generator） */
export type ClientAgentEventStream = AsyncGenerator<ClientAgentEvent>;

/**
 * 创建 ClientAgentEvent 的工厂函数。
 *
 * - 自动填充 `timestamp`，调用方只需关心 eventType / agentId / payload。
 * - 通过泛型 + `Extract` 实现 payload 类型收窄。
 *
 * @example
 * ```ts
 * const event = createClientAgentEvent(
 *   ClientAgentEventType.STREAM_CHUNK,
 *   "lead",
 *   { text: "hello" },
 * );
 * ```
 */
export function createClientAgentEvent<T extends ClientAgentEventType>(
  eventType: T,
  agentId: string,
  payload: Extract<ClientAgentEvent, { eventType: T }>["payload"],
): Extract<ClientAgentEvent, { eventType: T }> {
  return {
    eventType,
    timestamp: Date.now(),
    agentId,
    payload,
  } as Extract<ClientAgentEvent, { eventType: T }>;
}
