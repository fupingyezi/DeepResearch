/**
 * chat_session 表 —— 会话（对话侧栏项）域类型与 Store 契约。
 *
 * ⚠️ 本 store 不是该表的唯一读写入口：harness 的 TitleMiddleware（title-middleware）
 * 会绕过本 store 直接读（left join threads_meta）写（update chat_session set title）
 * 该表 —— 修改表结构时必须同步检查那一处 SQL。
 */

import type { SqlExecutor } from '../shared';

/** 会话记录（camelCase，毫秒时间戳 —— 与前端 ChatSessionType 对齐）。 */
export interface ChatSessionRecord {
  id: string;
  seq_id: number;
  title: string;
  /** 毫秒时间戳（与前端 ChatSessionType 对齐） */
  created_at: number;
  /** 毫秒时间戳 */
  updated_at: number;
}

export interface CreateChatSessionInput {
  id?: string;
  title?: string;
  seq_id?: number;
  /** 会话归属用户；按用户隔离 */
  userId: string;
  created_at?: string | number;
  updated_at?: string | number;
}

/** 会话存在但不属于当前用户（防越权把消息写进别人的会话）。 */
export class ChatSessionAccessError extends Error {
  readonly code = 'FORBIDDEN';

  constructor(message: string) {
    super(message);
    this.name = 'ChatSessionAccessError';
  }
}

/**
 * get_all_sessions 的 wire 行：字段名与 pg 列一致，日期保持 Date 对象。
 *
 * 不能 String()/getTime() 化：NextResponse.json 对 Date 序列化为 ISO 字符串，
 * 与现状字节一致（前端 formatYmd 兼容 string），改动即破坏 wire 契约。
 */
export interface ChatSessionWireRow {
  id: string;
  seq_id: number;
  title: string;
  user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ChatSessionStore {
  create(input: CreateChatSessionInput, db?: SqlExecutor): Promise<ChatSessionRecord>;
  /** 不存在 → null；属于他人 → 抛 ChatSessionAccessError；user_id IS NULL 视为无主放行 */
  getOwned(sessionId: string, userId: string): Promise<ChatSessionRecord | null>;
  /** getOwned → create → 23505 自愈回读（并发首请求竞争） */
  ensureOwned(input: CreateChatSessionInput): Promise<ChatSessionRecord>;
  /** 某用户下一个 seq_id：coalesce(max(seq_id),0)+1（按 user 隔离递增） */
  nextSeqId(userId: string): Promise<number>;
  /** 按 updated_at desc 返回 wire 形状原始行 */
  listByUser(userId: string): Promise<ChatSessionWireRow[]>;
  /** 重命名；0 行 → null（404 依据） */
  updateTitle(sessionId: string, userId: string, title: string): Promise<ChatSessionRecord | null>;
  /** 归属判定（cancel_run 用） */
  isOwned(sessionId: string, userId: string): Promise<boolean>;
  /** 删除；0 行 → null */
  deleteOwned(
    sessionId: string,
    userId: string,
    db?: SqlExecutor,
  ): Promise<ChatSessionRecord | null>;
}
