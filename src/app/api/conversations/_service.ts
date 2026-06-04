/**
 * conversations 相关共享 service
 *
 * - chat_session 创建：createChatSessionRecord
 * - chat_message 持久化：insertUserMessageRecord / insertAssistantMessageRecord
 *   均以 parts: MessagePart[] 入参，整数组一次性写入 chat_message.parts (jsonb)
 * - 截断：deleteMessagesAtOrAfter（recall / reEditCall 在 /api/v3/chat 路由内调用）
 * - history 加载：loadSessionHistory（返回前端可直接 setCurrentMessages 的 ChatMessageType[]）
 *
 * 不变量：
 *   message_id 全部使用 uuid 字符串；调用方未传则内部 uuidv4()。
 *   parts 写入用 JSON.stringify 序列化为 jsonb 字符串字面量；读出走 row.parts（pg
 */

import { v4 as uuidv4 } from 'uuid';

import { getClient, query } from '@/lib';
import type { ChatMessageType, MessagePart, fileMetadataType } from '@/types';
import { toIso } from '@/utils/common';

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

function rowToSessionRecord(row: Record<string, unknown>): ChatSessionRecord {
  return {
    id: String(row.id),
    seq_id: Number(row.seq_id),
    title: String(row.title),
    created_at: new Date(row.created_at as string | number | Date).getTime(),
    updated_at: new Date(row.updated_at as string | number | Date).getTime(),
  };
}

/**
 * 取某用户下一个 chat_session.seq_id：`coalesce(max(seq_id),0)+1`。
 *
 * 按 user 隔离序号，使每个用户的会话从 1 开始递增。
 */
async function nextSeqId(userId: string): Promise<number> {
  const res = await query(
    `select coalesce(max(seq_id), 0) + 1 as next_seq_id from chat_session where user_id = $1;`,
    [userId],
  );
  const v = res.rows[0]?.next_seq_id;
  return typeof v === 'number' ? v : Number(v ?? 1);
}

export async function createChatSessionRecord(
  input: CreateChatSessionInput,
): Promise<ChatSessionRecord> {
  const id = input.id && input.id.length > 0 ? input.id : uuidv4();
  const title = input.title && input.title.length > 0 ? input.title : 'New thread';
  const seq_id = typeof input.seq_id === 'number' ? input.seq_id : await nextSeqId(input.userId);
  const nowIso = new Date().toISOString();
  const createdAtIso = toIso(input.created_at) || nowIso;
  const updatedAtIso = toIso(input.updated_at) || nowIso;

  const res = await query(
    `insert into chat_session (id, seq_id, title, user_id, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6)
     returning *;`,
    [id, seq_id, title, input.userId, createdAtIso, updatedAtIso],
  );

  return rowToSessionRecord(res.rows[0]);
}

// chat_message 持久化（parts 模型）

export interface SavedFileMetadata {
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  minioKey: string;
}

export interface InsertUserMessageInput {
  sessionId: string;
  /** 消息归属用户 */
  userId: string;
  /** 不传则内部 uuidv4() */
  messageId?: string;
  parts: MessagePart[];
  /** 与 message 关联的文件元信息，写入 file_metadata 表 */
  uploadedFiles?: SavedFileMetadata[];
}

export interface InsertUserMessageResult {
  messageId: string;
}

export interface InsertAssistantMessageInput {
  sessionId: string;
  /** 消息归属用户 */
  userId: string;
  messageId: string;
  parts: MessagePart[];
  /** human-in-the-loop 中断（独立于 parts 持久化） */
  interrupt?: ChatMessageType['interrupt'];
}

type ClientLike = { query: (sql: string, p?: unknown[]) => Promise<{ rows: unknown[] }> };

async function insertFileMetadataRows(
  client: ClientLike,
  sessionId: string,
  messageId: string,
  files: SavedFileMetadata[] | undefined,
): Promise<void> {
  if (!files || files.length === 0) return;
  const bucket = process.env.MINIO_BUCKET;
  if (!bucket) {
    console.warn('[insertFileMetadataRows] MINIO_BUCKET not set, skip file metadata insert.');
    return;
  }
  const sql = `
    insert into file_metadata (
      id, message_id, session_id, filename, mime_type, size_bytes, minio_bucket, minio_key
    ) values ($1, $2, $3, $4, $5, $6, $7, $8)
  `;
  for (const file of files) {
    await client.query(sql, [
      file.fileId,
      messageId,
      sessionId,
      file.filename,
      file.mimeType,
      file.sizeBytes,
      bucket,
      file.minioKey,
    ]);
  }
}

/**
 * 把 user message 写入 chat_message 表，并把关联的文件元信息一并落 file_metadata。
 *
 * 在事务内执行：chat_message insert + file_metadata insert 全部成功才提交。
 */
export async function insertUserMessageRecord(
  input: InsertUserMessageInput,
): Promise<InsertUserMessageResult> {
  const messageId = input.messageId && input.messageId.length > 0 ? input.messageId : uuidv4();
  const partsJson = JSON.stringify(input.parts ?? []);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    await client.query(
      `insert into chat_message (id, session_id, user_id, role, parts)
       values ($1, $2, $3, 'user', $4::jsonb);`,
      [messageId, input.sessionId, input.userId, partsJson],
    );

    await insertFileMetadataRows(client, input.sessionId, messageId, input.uploadedFiles);

    await client.query('COMMIT');

    return { messageId };
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[insertUserMessageRecord] rollback failed:', rollbackErr);
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 把 assistant message 写入 chat_message 表（END 时由 collector.finalize 后调用）。
 *
 * interrupt 字段未独立列存储，需要时可以挂到 parts 之外的 jsonb metadata（本次
 * 暂未引入；流式期间前端会显示 interrupt，落库后由 history 加载时再决定是否显示
 * —— 当前实现：interrupt 信息仅在内存运行期保留）。
 */
export async function insertAssistantMessageRecord(
  input: InsertAssistantMessageInput,
): Promise<void> {
  const partsJson = JSON.stringify(input.parts ?? []);
  await query(
    `insert into chat_message (id, session_id, user_id, role, parts)
     values ($1, $2, $3, 'assistant', $4::jsonb);`,
    [input.messageId, input.sessionId, input.userId, partsJson],
  );
}

/**
 * 截断指定 sessionId 下 created_at >= fromCreatedAt 的所有 chat_message。
 *
 * 用于 recall / reEditCall：
 *   - recall：fromCreatedAt = 最近 assistant message 的 created_at
 *   - reEditCall：fromCreatedAt = 最近一对 user 的 created_at
 *
 * 关联 file_metadata 通过外键 ON DELETE CASCADE 自动清理。
 */
export async function deleteMessagesAtOrAfter(
  sessionId: string,
  fromCreatedAt: string | Date,
): Promise<void> {
  const isoTime =
    fromCreatedAt instanceof Date
      ? fromCreatedAt.toISOString()
      : new Date(fromCreatedAt).toISOString();
  await query(`delete from chat_message where session_id = $1 and created_at >= $2;`, [
    sessionId,
    isoTime,
  ]);
}

export interface LatestMessageRow {
  id: string;
  role: 'user' | 'assistant';
  createdAt: Date;
}

/**
 * 获取最近一条指定 role 的消息（按 created_at desc 取首行）。
 */
export async function getLatestMessageByRole(
  sessionId: string,
  role: 'user' | 'assistant',
): Promise<LatestMessageRow | null> {
  const res = await query(
    `select id, role, created_at from chat_message
      where session_id = $1 and role = $2
      order by created_at desc
      limit 1;`,
    [sessionId, role],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    role: row.role as 'user' | 'assistant',
    createdAt: new Date(row.created_at),
  };
}

// history 加载

/**
 * 把 file_metadata 行映射到前端 fileMetadataType。
 */
function rowToFileMetadata(row: Record<string, unknown>): fileMetadataType {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    sessionId: String(row.session_id),
    filename: String(row.filename),
    mimeType: String(row.mime_type ?? ''),
    sizeBytes: Number(row.size_bytes ?? 0),
    minioBucket: String(row.minio_bucket ?? ''),
    minioKey: String(row.minio_key ?? ''),
    uploadedAt: new Date(row.uploaded_at as string | number | Date),
  };
}

/**
 * 加载某个 session 的全部消息历史，含 file_metadata 单次批量补全。
 *
 * 按 userId 校验归属：仅返回属于该用户的 session 消息（防越权读取他人会话）。
 * 单查 chat_message + 单查 file_metadata，避免按 message 逐条查的 N+1。
 */
export async function loadSessionHistory(
  sessionId: string,
  userId: string,
): Promise<ChatMessageType[]> {
  const ownRes = await query(`select 1 from chat_session where id = $1 and user_id = $2 limit 1;`, [
    sessionId,
    userId,
  ]);
  if (ownRes.rows.length === 0) return [];

  const messageRes = await query(
    `select id, session_id, role, parts, created_at from chat_message
      where session_id = $1
      order by created_at asc;`,
    [sessionId],
  );

  const fileRes = await query(
    `select id, message_id, session_id, filename, mime_type, size_bytes, minio_bucket, minio_key, uploaded_at
       from file_metadata
      where session_id = $1
      order by uploaded_at asc;`,
    [sessionId],
  );

  const filesByMessage = new Map<string, fileMetadataType[]>();
  for (const row of fileRes.rows) {
    const file = rowToFileMetadata(row as Record<string, unknown>);
    const arr = filesByMessage.get(file.messageId) ?? [];
    arr.push(file);
    filesByMessage.set(file.messageId, arr);
  }

  const messages: ChatMessageType[] = messageRes.rows.map((row: Record<string, unknown>) => {
    const id = String(row.id);
    // jsonb 已被 pg 自动反序列化，单层断言到契约类型（外部边界，project.md §2.2）
    const parts = (row.parts ?? []) as MessagePart[];
    return {
      id,
      sessionId: String(row.session_id),
      role: row.role as 'user' | 'assistant',
      parts,
      createdAt: new Date(row.created_at as string | number | Date).getTime(),
      files: filesByMessage.get(id),
    };
  });

  return messages;
}

// 文件 id → 元信息批量解析（v3/chat 路由把 message.contents 中的 file/image
// block 解析为完整元信息后落库）

export async function resolveFilesByIds(fileIds: string[]): Promise<SavedFileMetadata[]> {
  if (!Array.isArray(fileIds) || fileIds.length === 0) return [];

  const uniqueIds = Array.from(
    new Set(fileIds.filter((id) => typeof id === 'string' && id.length > 0)),
  );
  if (uniqueIds.length === 0) return [];

  const res = await query(
    `select file_id, filename, mime_type, size_bytes, minio_key
       from file_content
      where file_id = any($1::uuid[])`,
    [uniqueIds],
  );

  const byId = new Map<string, SavedFileMetadata>();
  for (const row of res.rows) {
    const fileId = String(row.file_id ?? '');
    if (!fileId) continue;
    byId.set(fileId, {
      fileId,
      filename: String(row.filename ?? ''),
      mimeType: String(row.mime_type ?? ''),
      sizeBytes: Number(row.size_bytes ?? 0),
      minioKey: String(row.minio_key ?? ''),
    });
  }

  // 保持入参顺序返回（content block 的视觉顺序对消息渲染重要）
  const ordered: SavedFileMetadata[] = [];
  for (const id of fileIds) {
    const hit = byId.get(id);
    if (hit) ordered.push(hit);
  }
  return ordered;
}
