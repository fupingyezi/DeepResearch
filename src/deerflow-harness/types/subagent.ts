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
 */
export type SubagentEvent =
  | { kind: 'started'; taskId: string; description?: string; subagentType?: string }
  | {
      kind: 'ai_message';
      taskId: string;
      message: unknown;
      index: number;
      total: number;
    }
  | { kind: 'completed'; taskId: string; result: string | null }
  | { kind: 'failed'; taskId: string; error: string }
  | { kind: 'timed_out'; taskId: string; error: string }
  | { kind: 'cancelled'; taskId: string; error?: string };
