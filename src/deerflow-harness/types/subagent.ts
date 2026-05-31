export enum SubagentStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  TIMEOUT = 'timeout',
}

export interface SubagentResult {
  taskId: string;
  traceId: string;
  status: SubagentStatus;
  result: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  assistantMessages: Record<string, any>[];
  abortController: AbortController;
}

export function createSubagentResult(
  taskId: string,
  traceId: string,
  status: SubagentStatus = SubagentStatus.PENDING,
): SubagentResult {
  return {
    taskId,
    traceId,
    status,
    result: null,
    error: null,
    startedAt: null,
    completedAt: null,
    assistantMessages: [],
    abortController: new AbortController(),
  };
}

/**
 * SubagentEvent —— Executor 与 task-tool 之间的内部协议。
 *
 * 新增 `tool_call` / `tool_result` 用于把 subagent 内部的工具调用
 * （如 search_web_tool）透传给前端，让 timeline 能展开看到子任务里
 * 究竟搜了什么、查了什么。
 *
 * `completed` 增加 `structured` 字段：解析自 final-report fenced block 的
 * SubagentReport JSON。解析失败时为 null（lead-agent 拿到的仍是原文本）。
 */
export type SubagentEvent =
  | { kind: 'started'; taskId: string; description?: string; subagentType?: string }
  | {
      kind: 'ai_message';
      taskId: string;
      /** 已精简为 plain object：只保留 text + tool_calls 摘要，不含 LC 类实例 */
      message: any;
      index: number;
      total: number;
      /** 含 tool_calls 时的 planning 文本，归入 timeline reasoning；不含时为 undefined */
      reasoning?: string;
    }
  | {
      kind: 'tool_call';
      taskId: string;
      /** 子工具调用的唯一 id（直接复用 LangGraph 给的 toolCallId） */
      toolCallId: string;
      toolName: string;
      /** 入参（已序列化为 JSON 字符串，与 lead 工具调用协议一致） */
      arguments?: string;
    }
  | {
      kind: 'tool_result';
      taskId: string;
      toolCallId: string;
      toolName: string;
      result: any;
      success: boolean;
      errorMessage?: string;
    }
  | {
      kind: 'completed';
      taskId: string;
      /** 给 lead-agent 的纯文本结果（去掉 fenced JSON block 的 markdown） */
      result: string | null;
      /** 解析自 final-report 的结构化数据；失败时为 null */
      structured?: unknown;
    }
  | { kind: 'failed'; taskId: string; error: string }
  | { kind: 'timed_out'; taskId: string; error: string }
  | { kind: 'cancelled'; taskId: string; error?: string };
