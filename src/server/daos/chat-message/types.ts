import type { MessagePart } from '@/types';

import type { SqlExecutor } from '../shared';

/** chat_message 行（listBySession 返回形状：与 pg 列一致，Date 保持 Date）。 */
export interface ChatMessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  /** jsonb 已被 pg 自动反序列化 */
  parts: MessagePart[];
  created_at: Date;
}

export interface InsertChatMessageInput {
  sessionId: string;
  /** 消息归属用户 */
  userId: string;
  /** 不传则内部 uuidv4() */
  messageId?: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
}

/** 最近一条指定 role 的消息（created_at desc 首行）。 */
export interface LatestMessageRow {
  id: string;
  role: 'user' | 'assistant';
  createdAt: Date;
}

/** resume 续写的 seed：最近一条 assistant 消息的 id 与既有 parts。 */
export interface LatestAssistantParts {
  id: string;
  parts: MessagePart[];
}

export interface ChatMessageStore {
  insert(input: InsertChatMessageInput, db?: SqlExecutor): Promise<{ messageId: string }>;
  /** resume 续写回写：where id = $1 and role = 'assistant'（不碰 user 消息） */
  updateParts(messageId: string, parts: MessagePart[]): Promise<void>;
  /** 截断 created_at >= fromCreatedAt 的消息（recall/reEditCall；file_metadata 靠外键级联） */
  deleteAtOrAfter(sessionId: string, fromCreatedAt: string | Date): Promise<void>;
  getLatestByRole(sessionId: string, role: 'user' | 'assistant'): Promise<LatestMessageRow | null>;
  getLatestAssistantWithParts(
    sessionId: string,
    userId: string,
  ): Promise<LatestAssistantParts | null>;
  /** 按 created_at asc 全量返回（history 加载；单查防 N+1） */
  listBySession(sessionId: string): Promise<ChatMessageRow[]>;
  /** 删除会话下该用户全部消息（deleteSession 事务内） */
  deleteBySession(sessionId: string, userId: string, db?: SqlExecutor): Promise<void>;
}
