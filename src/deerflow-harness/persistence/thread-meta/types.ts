/**
 * ThreadMeta 用户级线程元信息（与 LangGraph checkpoint 解耦）
 */

export type ThreadStatus = 'idle' | 'running' | 'error' | 'interrupted';

export interface ThreadMeta {
  thread_id: string;
  assistant_id: string;
  /** 当前阶段 user_id 可选；未来接入鉴权时再强制 */
  user_id?: string | null;
  display_name: string;
  status: ThreadStatus;
  metadata: Record<string, any>;
  /** ISO 8601 字符串 */
  created_at: string;
  updated_at: string;
}

export interface ThreadMetaCreateInput {
  thread_id: string;
  assistant_id?: string;
  user_id?: string | null;
  display_name?: string;
  metadata?: Record<string, any>;
}

export interface ThreadMetaSearchOptions {
  user_id?: string | null;
  status?: ThreadStatus;
  /** jsonb 包含匹配（PG @> ）的子结构 */
  metadata?: Record<string, any>;
  limit?: number;
  offset?: number;
}

export interface ThreadMetaAccessOptions {
  /** 当资源不存在时是否视为拒绝；默认 false（不存在按放行） */
  require_existing?: boolean;
}

export interface ThreadMetaStore {
  create(input: ThreadMetaCreateInput): Promise<ThreadMeta>;
  get(thread_id: string, opts?: { user_id?: string | null }): Promise<ThreadMeta | null>;
  search(opts: ThreadMetaSearchOptions): Promise<ThreadMeta[]>;
  updateDisplayName(thread_id: string, name: string, opts?: { user_id?: string | null }): Promise<void>;
  updateStatus(thread_id: string, status: ThreadStatus, opts?: { user_id?: string | null }): Promise<void>;
  updateMetadata(
    thread_id: string,
    patch: Record<string, any>,
    opts?: { user_id?: string | null },
  ): Promise<void>;
  /** user_id 为空时直接放行；存在则做 owner 校验。 */
  checkAccess(
    thread_id: string,
    user_id: string | null | undefined,
    opts?: ThreadMetaAccessOptions,
  ): Promise<boolean>;
  delete(thread_id: string, opts?: { user_id?: string | null }): Promise<void>;
}
