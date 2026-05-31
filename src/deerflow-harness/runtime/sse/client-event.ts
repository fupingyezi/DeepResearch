/**
 * ClientAgentEvent —— 前后端共享的对外事件协议（白名单 10 项）
 *
 * 设计原则：
 * - 这是后端发往前端的事件「白名单」，前端 `src/runtime/protocol/client-event.ts`
 *   通过 re-export 直接复用本文件的枚举与类型，避免双向手动维护。
 * - 内部观测事件（NODE_ENTER / NODE_EXIT / LLM_COMPLETE / SUB_AGENT_DISPATCH /
 *   HARNESS_LIFECYCLE / HUMAN_RESUME / TASK_STARTED|RUNNING|COMPLETED|FAILED|
 *   CANCELLED|TIMED_OUT 等）一律不出现在该协议中；如需观测，请订阅内部
 *   `AgentEvent` 而非 `ClientAgentEvent`，或在 `to-client-event.ts` 边界 drop。
 *
 * 该文件 **必须保持纯类型与枚举**（零 node-only 依赖），以便前端 bundle 直接
 * 复用。
 */

/** 客户端事件类型枚举（白名单 10 项，与前端严格一致） */
export enum ClientAgentEventType {
  /** 流式会话开始 */
  START = 'start',
  /** LLM 增量文本块 */
  STREAM_CHUNK = 'stream_chunk',
  /** 工具调用开始 */
  TOOL_CALL = 'tool_call',
  /** 工具调用结果 */
  TOOL_RESULT = 'tool_result',
  /** 状态变更（DeepResearch 等场景） */
  STATE_UPDATE = 'state_update',
  /** 任务进度更新（折叠所有 task_* 内部事件） */
  TASK_PROGRESS = 'task_progress',
  /** 人工中断（等待决策） */
  HUMAN_INTERRUPT = 'human_interrupt',
  /** 错误 */
  ERROR = 'error',
  /** 流式会话结束 */
  END = 'end',
  /** 心跳（其余内部事件降级保活） */
  HEARTBEAT = 'heartbeat',
}

export interface StartPayload {
  sessionId?: string;
  /**
   * 完整的 chat_session 元信息，仅在新建 session 场景下由后端首次下发，
   * 前端据此把临时 session 替换为真实记录并加入侧栏。
   *
   * - 若 `sessionId` 与前端当前 sessionId 一致，前端应跳过替换。
   * - `created_at` / `updated_at` 为毫秒时间戳。
   */
  chatSession?: {
    id: string;
    seq_id: number;
    title: string;
    created_at: number;
    updated_at: number;
  };
  /**
   * 后端为本轮对话分配的真实 message id（UUID 字符串）。
   *
   * - `userMessageId`：后端在收到请求后立即写入 chat_message 后回传的 id。
   *   前端据此把临时 user message 的 id 替换为真实 id（用于后续删除/截断）。
   * - `assistantMessageId`：后端预生成的 assistant message id（在 END 时写入 DB
   *   时使用同一个 id）。前端据此把占位 assistant message 的 id 替换为真实 id，
   *   保持 React key 稳定与 DB 一致。
   *
   * 仅在普通发送 / recall / reEditCall 场景下下发；resume 场景按原行为不变。
   */
  userMessageId?: string;
  assistantMessageId?: string;
}

export interface StreamChunkPayload {
  /** 增量正文（最终答案）；纯推理时省略 */
  text?: string;
  /** 推理/思考文本（含 tool_calls 时的 planning 文本） */
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
  result: any;
  success: boolean;
  errorMessage?: string;
}

export interface StateUpdatePayload {
  /** 状态子类型，供前端按需分发 */
  stateType:
    | 'simple_analysis'
    | 'tasks_initial'
    | 'task_update'
    | 'report'
    | 'research_target'
    | 'custom';
  data: any;
}

/**
 * TaskProgressPayload —— 折叠 task_started / task_running / task_completed /
 * task_failed / task_cancelled / task_timed_out 六类 internal 事件，并新增
 * task_tool_call / task_tool_result 用于把 subagent 内部的工具调用透传给前端。
 *
 * - status:
 *    'started' | 'running' | 'tool_call' | 'tool_result' |
 *    'completed' | 'failed' | 'cancelled' | 'timed_out'
 *   其余字段按 status 语义可选填。
 */
export interface TaskProgressPayload {
  taskId: string;
  status: string;
  description?: string;
  /** subagent 类型名（仅 started 时有值） */
  subagentType?: string;
  /** 增量 message（仅 running 时有值） */
  message?: any;
  messageIndex?: number;
  totalMessages?: number;
  /** sub-agent 内部 AI message 的思考/规划文本（仅 running 时有值） */
  reasoning?: string;
  /** 终态结果（completed 时） */
  result?: string | null;
  /** 终态结构化报告（completed 时，可能为 null） */
  structured?: unknown;
  /** 终态错误（failed / cancelled / timed_out 时） */
  error?: string | null;
  /** subagent 内部工具调用相关字段（仅 tool_call / tool_result 时有值） */
  toolCallId?: string;
  toolName?: string;
  /** tool_call 的 arguments（JSON 字符串） */
  arguments?: string;
  /** tool_result 的 result/success/errorMessage */
  toolResult?: any;
  toolSuccess?: boolean;
  toolErrorMessage?: string;
  /** 扩展字段（前端按需透传） */
  [k: string]: any;
}

export interface HumanInterruptPayload {
  question: string;
  details: any;
}

export interface ErrorPayload {
  errorCode: string;
  errorMessage: string;
  recoverable: boolean;
}

/** END / HEARTBEAT 不携带业务字段 */
export type EndPayload = Record<string, never>;
export type HeartbeatPayload = Record<string, never>;

interface BaseClientAgentEvent {
  /** 事件时间戳（毫秒） */
  timestamp: number;
  /** Agent 标识（lead / sub-agent name 等） */
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

/** 客户端事件联合类型（discriminated union） */
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
