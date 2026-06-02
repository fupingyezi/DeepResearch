/**
 * parts-reducer
 *
 * SSE → assistant parts[] 聚合器
 *
 * 合并规则（与历史 AssistantPartsCollector 一致）：
 *  - 连续 stream_chunk.text     → 合并到一个 text part 的 content.text
 *  - 连续 stream_chunk.reasoning → 合并到一个 reasoning part 的 content.text
 *  - text/reasoning 被另一文本类型 part 打断后，再次出现需新建 part
 *  - tool_call → push tool_call part；TOOL_RESULT 通过 toolCallId 反查
 *    把 status / result / success / errorMessage 写回（极端时序错乱时
 *    作为独立 tool_result part 兜底）
 *  - subagent_task：upsert by taskId；reasoning 累积；children 维护工具调用 history
 *  - HUMAN_INTERRUPT → 写顶层 interrupt（不入 parts）
 *  - START / END / HEARTBEAT / ERROR → 状态不变（ERROR 由调用方在 catch 处理）
 */

import { v4 as uuidv4 } from 'uuid';

import type {
  ClientAgentEvent,
  TaskProgressPayload,
} from '@deerflow-harness/runtime/sse/client-event';
import { ClientAgentEventType as Et } from '@deerflow-harness/runtime/sse/client-event';
import type { ChatMessageType, MessagePart, SubagentToolCall } from '@/types';
import { extractFinalMessageParts } from '@/utils/chat/final-message-extract';
import { parseJsonSafe, hasMeaningfulArgs } from '@/utils/common';

type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;
type SubagentTaskPart = Extract<MessagePart, { type: 'subagent_task' }>;
type TextPart = Extract<MessagePart, { type: 'text' }>;
type ReasoningPart = Extract<MessagePart, { type: 'reasoning' }>;

/**
 * 不可变聚合状态。
 * - parts：当前累积的消息块；reduce 后未变化时引用保持不变
 * - lastPartType：用于 UI debug；reducer 内部不再依赖此字段做合并判定
 * - indexByToolCallId / indexByTaskId：O(1) 反查 part 下标
 * - interrupt：顶层 human-in-the-loop 标记，不入 parts
 */
export interface PartsState {
  readonly parts: readonly MessagePart[];
  readonly lastPartType: MessagePart['type'] | null;
  readonly indexByToolCallId: ReadonlyMap<string, number>;
  readonly indexByTaskId: ReadonlyMap<string, number>;
  readonly interrupt: ChatMessageType['interrupt'];
}

export const initialPartsState: PartsState = {
  parts: [],
  lastPartType: null,
  indexByToolCallId: new Map(),
  indexByTaskId: new Map(),
  interrupt: null,
};

/**
 * 用既有 parts 构造初始 state（resume 场景）。
 * 重建 toolCallId / taskId 索引；interrupt 默认清空（resume 表示用户已应答上一轮中断）。
 */
export function createPartsStateFromExisting(parts: readonly MessagePart[]): PartsState {
  const indexByToolCallId = new Map<string, number>();
  const indexByTaskId = new Map<string, number>();
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type === 'tool_call') {
      indexByToolCallId.set(part.content.toolCallId, i);
    } else if (part.type === 'subagent_task') {
      indexByTaskId.set(part.content.taskId, i);
    }
  }
  return {
    parts: parts.slice(),
    lastPartType: parts[parts.length - 1]?.type ?? null,
    indexByToolCallId,
    indexByTaskId,
    interrupt: null,
  };
}

/**
 * 单步 reduce。返回新的 state；若事件不影响状态（START / END / HEARTBEAT /
 * ERROR / 空 stream_chunk），原 state 引用直接返回。
 */
export function reducePartsState(state: PartsState, event: ClientAgentEvent): PartsState {
  switch (event.eventType) {
    case Et.STREAM_CHUNK: {
      const { text, reasoning } = event.payload;
      let next = state;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        next = appendOrMergeReasoning(next, reasoning);
      }
      if (typeof text === 'string' && text.length > 0) {
        next = appendOrMergeText(next, text);
      }
      return next;
    }

    case Et.TOOL_CALL:
      return pushToolCall(state, event.payload);

    case Et.TOOL_RESULT:
      return attachToolResult(state, event.payload);

    case Et.TASK_PROGRESS:
      return upsertSubagentTask(state, event.payload);

    case Et.HUMAN_INTERRUPT:
      return {
        ...state,
        interrupt: {
          question: event.payload.question,
          details: event.payload.details,
        },
      };

    case Et.START:
    case Et.END:
    case Et.HEARTBEAT:
    case Et.ERROR:
      return state;

    default: {
      const _never: never = event;
      void _never;
      return state;
    }
  }
}

/**
 * END 时调用：执行 task_summary / artifact 标记抽取。
 * 返回最终落库 / 渲染结构。state 本身保持不可变。
 */
export function finalizePartsState(
  state: PartsState,
  fallbackTitle = '',
): { parts: MessagePart[]; interrupt: ChatMessageType['interrupt'] } {
  const finalParts = extractFinalMessageParts([...state.parts], fallbackTitle);
  return { parts: finalParts, interrupt: state.interrupt };
}

/**
 * 直接追加一个独立 text part（不与上一段合并）。
 * 用途：流被中止 / 报错时的用户可见兜底文本（"出错了"等）。
 */
export function appendStandaloneText(state: PartsState, text: string): PartsState {
  const part: TextPart = {
    partId: uuidv4(),
    type: 'text',
    createdAt: Date.now(),
    content: { text },
  };
  return {
    ...state,
    parts: [...state.parts, part],
    lastPartType: 'text',
  };
}

function appendOrMergeText(state: PartsState, text: string): PartsState {
  const idx = findMergeTarget(state.parts, 'text');
  if (idx >= 0) {
    const last = state.parts[idx] as TextPart;
    const merged: TextPart = {
      ...last,
      content: { text: last.content.text + text },
    };
    return {
      ...state,
      parts: replaceAt(state.parts, idx, merged),
      lastPartType: 'text',
    };
  }
  const part: TextPart = {
    partId: uuidv4(),
    type: 'text',
    createdAt: Date.now(),
    content: { text },
  };
  return {
    ...state,
    parts: [...state.parts, part],
    lastPartType: 'text',
  };
}

function appendOrMergeReasoning(state: PartsState, text: string): PartsState {
  const idx = findMergeTarget(state.parts, 'reasoning');
  if (idx >= 0) {
    const last = state.parts[idx] as ReasoningPart;
    const merged: ReasoningPart = {
      ...last,
      content: { text: last.content.text + text },
    };
    return {
      ...state,
      parts: replaceAt(state.parts, idx, merged),
      lastPartType: 'reasoning',
    };
  }
  const part: ReasoningPart = {
    partId: uuidv4(),
    type: 'reasoning',
    createdAt: Date.now(),
    content: { text },
  };
  return {
    ...state,
    parts: [...state.parts, part],
    lastPartType: 'reasoning',
  };
}

/**
 * 自尾向前找可合并的同类型 part 下标；穿过 subagent_task / tool_call /
 * tool_result（lead 在等待并行 task 工具时，TASK_PROGRESS 会反复 upsert
 * 同一个 subagent_task part，与 lead 自身的 reasoning chunk 交替到达）；
 * 一旦遇到另一个文本类 part（text/reasoning 中的另一种）则视为段落边界。
 */
function findMergeTarget(parts: readonly MessagePart[], target: 'text' | 'reasoning'): number {
  const other = target === 'text' ? 'reasoning' : 'text';
  for (let i = parts.length - 1; i >= 0; i--) {
    const t = parts[i].type;
    if (t === target) return i;
    if (t === other) return -1;
    if (t === 'subagent_task' || t === 'tool_call' || t === 'tool_result') continue;
    return -1;
  }
  return -1;
}

function pushToolCall(
  state: PartsState,
  payload: { toolCallId: string; toolName: string; arguments?: string },
): PartsState {
  const args = parseJsonSafe(payload.arguments);
  const part: ToolCallPart = {
    partId: uuidv4(),
    type: 'tool_call',
    createdAt: Date.now(),
    content: {
      toolCallId: payload.toolCallId,
      name: payload.toolName,
      args,
      status: 'running',
    },
  };
  const nextParts = [...state.parts, part];
  const nextIndex = new Map(state.indexByToolCallId);
  nextIndex.set(payload.toolCallId, nextParts.length - 1);
  return {
    ...state,
    parts: nextParts,
    indexByToolCallId: nextIndex,
    lastPartType: 'tool_call',
  };
}

function attachToolResult(
  state: PartsState,
  payload: {
    toolCallId: string;
    toolName: string;
    result: unknown;
    success: boolean;
    errorMessage?: string;
  },
): PartsState {
  const idx = state.indexByToolCallId.get(payload.toolCallId);
  if (typeof idx === 'number') {
    const target = state.parts[idx];
    if (target && target.type === 'tool_call') {
      const updated: ToolCallPart = {
        ...target,
        content: {
          ...target.content,
          result: payload.result,
          success: payload.success,
          errorMessage: payload.errorMessage,
          status: payload.success === false ? 'failed' : 'done',
        },
      };
      return {
        ...state,
        parts: replaceAt(state.parts, idx, updated),
      };
    }
  }
  // 时序错乱兜底：先收到 result 而无对应 tool_call → 独立 tool_result part
  const fallback: MessagePart = {
    partId: uuidv4(),
    type: 'tool_result',
    createdAt: Date.now(),
    content: {
      toolCallId: payload.toolCallId,
      result: payload.result,
      success: payload.success,
      errorMessage: payload.errorMessage,
    },
  };
  return {
    ...state,
    parts: [...state.parts, fallback],
    lastPartType: 'tool_result',
  };
}

function upsertSubagentTask(state: PartsState, payload: TaskProgressPayload): PartsState {
  const taskId = payload.taskId ?? '';
  const status = payload.status ?? 'running';

  if (status === 'tool_call' || status === 'tool_result') {
    return applySubagentToolEvent(state, taskId, payload, status);
  }

  const idx = state.indexByTaskId.get(taskId);
  const prev = typeof idx === 'number' ? (state.parts[idx] as SubagentTaskPart) : null;

  const incomingReasoning =
    typeof payload.reasoning === 'string' && payload.reasoning.length > 0
      ? payload.reasoning
      : undefined;
  const prevReasoning = prev?.content.reasoning ?? '';
  const nextReasoning = incomingReasoning
    ? prevReasoning + incomingReasoning
    : prevReasoning || undefined;

  const next: SubagentTaskPart = {
    partId: prev?.partId ?? uuidv4(),
    type: 'subagent_task',
    createdAt: prev?.createdAt ?? Date.now(),
    content: {
      taskId,
      description:
        typeof payload.description === 'string' ? payload.description : prev?.content.description,
      subagentType:
        typeof payload.subagentType === 'string'
          ? payload.subagentType
          : prev?.content.subagentType,
      status,
      result:
        typeof payload.result === 'string' && payload.result.length > 0
          ? payload.result
          : prev?.content.result,
      error:
        typeof payload.error === 'string' && payload.error.length > 0
          ? payload.error
          : prev?.content.error,
      reasoning: nextReasoning,
      children: prev?.content.children ?? [],
      structured:
        payload.structured !== undefined
          ? (payload.structured as SubagentTaskPart['content']['structured'])
          : (prev?.content.structured ?? null),
    },
  };

  if (typeof idx === 'number') {
    return {
      ...state,
      parts: replaceAt(state.parts, idx, next),
      lastPartType: 'subagent_task',
    };
  }
  const nextParts = [...state.parts, next];
  const nextIndex = new Map(state.indexByTaskId);
  nextIndex.set(taskId, nextParts.length - 1);
  return {
    ...state,
    parts: nextParts,
    indexByTaskId: nextIndex,
    lastPartType: 'subagent_task',
  };
}

function applySubagentToolEvent(
  state: PartsState,
  taskId: string,
  payload: TaskProgressPayload,
  status: 'tool_call' | 'tool_result',
): PartsState {
  let working = state;
  let idx = working.indexByTaskId.get(taskId);

  if (typeof idx !== 'number') {
    // 父任务未到达，先占位 running 节点
    const placeholder: SubagentTaskPart = {
      partId: uuidv4(),
      type: 'subagent_task',
      createdAt: Date.now(),
      content: { taskId, status: 'running', children: [] },
    };
    const nextParts = [...working.parts, placeholder];
    const nextIndex = new Map(working.indexByTaskId);
    idx = nextParts.length - 1;
    nextIndex.set(taskId, idx);
    working = {
      ...working,
      parts: nextParts,
      indexByTaskId: nextIndex,
      lastPartType: 'subagent_task',
    };
  }

  const part = working.parts[idx] as SubagentTaskPart;
  const children: SubagentToolCall[] = [...(part.content.children ?? [])];
  const toolCallId = payload.toolCallId ?? '';

  if (status === 'tool_call') {
    const args = parseJsonSafe(payload.arguments);
    // args 为空且尚无 result → 跳过入 children，避免落库脏数据
    if (!hasMeaningfulArgs(args)) return working;
    const existIdx = children.findIndex((c) => c.toolCallId === toolCallId);
    const item: SubagentToolCall = {
      id: toolCallId || uuidv4(),
      toolCallId,
      name: payload.toolName ?? '',
      args,
      status: 'running',
    };
    if (existIdx === -1) children.push(item);
    else children[existIdx] = { ...children[existIdx], ...item, status: children[existIdx].status };
  } else {
    const success = payload.toolSuccess !== false;
    const result = payload.toolResult;
    const errorMessage =
      typeof payload.toolErrorMessage === 'string' ? payload.toolErrorMessage : undefined;
    const existIdx = children.findIndex((c) => c.toolCallId === toolCallId);
    if (existIdx === -1) {
      children.push({
        id: toolCallId || uuidv4(),
        toolCallId,
        name: payload.toolName ?? '',
        result,
        success,
        errorMessage,
        status: success ? 'done' : 'failed',
      });
    } else {
      children[existIdx] = {
        ...children[existIdx],
        result,
        success,
        errorMessage,
        status: success ? 'done' : 'failed',
      };
    }
  }

  const updated: SubagentTaskPart = {
    ...part,
    content: { ...part.content, children },
  };
  return {
    ...working,
    parts: replaceAt(working.parts, idx, updated),
    lastPartType: 'subagent_task',
  };
}

function replaceAt<T>(arr: readonly T[], idx: number, value: T): T[] {
  const next = arr.slice();
  next[idx] = value;
  return next;
}
