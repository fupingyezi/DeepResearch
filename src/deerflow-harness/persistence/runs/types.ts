/**
 * Run —— 单次 thread 执行的运行记录
 */

export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'interrupted';

export interface Run {
  run_id: string;
  thread_id: string;
  assistant_id: string;
  user_id?: string | null;
  status: RunStatus;
  input: any;
  error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunCreateInput {
  run_id: string;
  thread_id: string;
  assistant_id?: string;
  user_id?: string | null;
  input: any;
}

export interface RunListOptions {
  limit?: number;
  offset?: number;
  status?: RunStatus;
}

export interface RunStore {
  create(input: RunCreateInput): Promise<Run>;
  setStatus(run_id: string, status: RunStatus, error?: string | null): Promise<void>;
  get(run_id: string): Promise<Run | null>;
  listByThread(thread_id: string, opts?: RunListOptions): Promise<Run[]>;
}
