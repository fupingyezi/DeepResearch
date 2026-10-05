/**
 * 会话 / 消息域服务：chat_session + chat_message + file_metadata/file_content 编排。
 *
 * - 单体会话行 CRUD 与历史加载
 * - deleteSession：事务内删库 + commit 后 agent 侧数据与 MinIO 对象清理（顺序不可换）
 * - cancelRun：幂等取消（无可停 → cancelled: 0）
 * - 消息落库：saveUserMessage（事务）与 saveAssistantMessage / updateAssistantParts
 */

import type { ChatMessageType, MessagePart, fileMetadataType } from '@/types';
import { ThreadServiceError, type RunStore, type ThreadService } from '@/deerflow-harness';
import { deleteFile } from '@/lib/storage';
import { AppError } from '@/server/http';
import { getRunStore, getThreadService } from '@/server/wiring';
import type { ChatMessageStore } from '@/server/daos/chat-message';
import { PgChatMessageStore } from '@/server/daos/chat-message';
import type {
  ChatSessionRecord,
  ChatSessionStore,
  ChatSessionWireRow,
  CreateChatSessionInput,
} from '@/server/daos/chat-session';
import { PgChatSessionStore } from '@/server/daos/chat-session';
import type { SavedFileMetadata } from '@/server/daos/file-metadata';
import { PgFileMetadataStore, type FileMetadataStore } from '@/server/daos/file-metadata';
import { PgFileContentStore, type FileContentStore } from '@/server/daos/file-content';
import { withTransaction } from '@/server/daos/shared';

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

export interface InsertAssistantMessageInput {
  sessionId: string;
  /** 消息归属用户 */
  userId: string;
  messageId: string;
  parts: MessagePart[];
  /** human-in-the-loop 中断；仅内存运行期保留（不落库，历史加载时不回放） */
  interrupt?: ChatMessageType['interrupt'];
}

export interface LatestMessageRow {
  id: string;
  role: 'user' | 'assistant';
  createdAt: Date;
}

export interface ConversationServiceDeps {
  chatSessions: ChatSessionStore;
  chatMessages: ChatMessageStore;
  fileMetadata: FileMetadataStore;
  fileContent: FileContentStore;
  runStore: RunStore;
  getThreadService: () => Promise<ThreadService>;
  deleteFile: (minioKey: string) => Promise<void>;
}

export class ConversationService {
  constructor(private readonly deps: ConversationServiceDeps) {}

  // ---- chat_session ----

  /** 幂等确保会话行存在且归属当前用户（不存在建行；他人会话抛 ChatSessionAccessError）。 */
  ensureSession(input: CreateChatSessionInput): Promise<ChatSessionRecord> {
    return this.deps.chatSessions.ensureOwned(input);
  }

  /** 侧栏会话列表（wire 形状原始行，见 ChatSessionWireRow 契约）。 */
  listSessions(userId: string): Promise<ChatSessionWireRow[]> {
    return this.deps.chatSessions.listByUser(userId);
  }

  /** 重命名；会话不存在或不属于该用户 → SESSION_NOT_FOUND(404)。 */
  async renameSession(
    sessionId: string,
    userId: string,
    title: string,
  ): Promise<ChatSessionRecord> {
    const updated = await this.deps.chatSessions.updateTitle(sessionId, userId, title);
    if (!updated) throw new AppError('Session not found', 'SESSION_NOT_FOUND', 404);
    return updated;
  }

  // ---- chat_message ----

  /** 写 user 消息 + 关联 file_metadata（同一事务，全部成功才提交）。 */
  async saveUserMessage(input: InsertUserMessageInput): Promise<{ messageId: string }> {
    return withTransaction(async (db) => {
      const { messageId } = await this.deps.chatMessages.insert(
        {
          sessionId: input.sessionId,
          userId: input.userId,
          messageId: input.messageId,
          role: 'user',
          parts: input.parts,
        },
        db,
      );
      await this.deps.fileMetadata.insertMany(
        input.uploadedFiles ?? [],
        { sessionId: input.sessionId, messageId },
        db,
      );
      return { messageId };
    });
  }

  saveAssistantMessage(input: InsertAssistantMessageInput): Promise<{ messageId: string }> {
    return this.deps.chatMessages.insert({
      sessionId: input.sessionId,
      userId: input.userId,
      messageId: input.messageId,
      role: 'assistant',
      parts: input.parts,
    });
  }

  /** resume 续写回写（只匹配 role='assistant' 的行）。 */
  updateAssistantParts(messageId: string, parts: MessagePart[]): Promise<void> {
    return this.deps.chatMessages.updateParts(messageId, parts);
  }

  /** recall / reEditCall 截断：删除 created_at >= fromCreatedAt 的消息。 */
  deleteMessagesAtOrAfter(sessionId: string, fromCreatedAt: string | Date): Promise<void> {
    return this.deps.chatMessages.deleteAtOrAfter(sessionId, fromCreatedAt);
  }

  getLatestMessageByRole(
    sessionId: string,
    role: 'user' | 'assistant',
  ): Promise<LatestMessageRow | null> {
    return this.deps.chatMessages.getLatestByRole(sessionId, role);
  }

  /** recall 重放的原始提问：最近一条 user 消息（含 parts）。 */
  getLatestUserMessageWithParts(sessionId: string) {
    return this.deps.chatMessages.getLatestUserWithParts(sessionId);
  }

  /** resume 续写的 seed：最近一条 assistant 消息的 id 与既有 parts。 */
  getLatestAssistantWithParts(
    sessionId: string,
    userId: string,
  ): Promise<{ id: string; parts: MessagePart[] } | null> {
    return this.deps.chatMessages.getLatestAssistantWithParts(sessionId, userId);
  }

  // ---- 文件 id → 元信息批量解析 ----

  resolveFilesByIds(fileIds: string[]): Promise<SavedFileMetadata[]> {
    return this.deps.fileContent.getByIds(fileIds);
  }

  // ---- 历史加载 ----

  /**
   * 加载某个 session 的全部消息历史（归属校验不通过返回空数组，不泄露他人会话）。
   * 单查 chat_message + 单查 file_metadata，避免按消息逐条查的 N+1。
   */
  async loadSessionHistory(sessionId: string, userId: string): Promise<ChatMessageType[]> {
    const owned = await this.deps.chatSessions.isOwned(sessionId, userId);
    if (!owned) return [];

    const [messageRows, fileRows] = await Promise.all([
      this.deps.chatMessages.listBySession(sessionId),
      this.deps.fileMetadata.listBySession(sessionId),
    ]);

    const filesByMessage = new Map<string, fileMetadataType[]>();
    for (const file of fileRows) {
      const arr = filesByMessage.get(file.messageId) ?? [];
      arr.push(file);
      filesByMessage.set(file.messageId, arr);
    }

    return messageRows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      parts: row.parts,
      createdAt: row.created_at.getTime(),
      files: filesByMessage.get(row.id),
    }));
  }

  // ---- 取消 ----

  /**
   * 取消该会话正在跑的 run。幂等：会话不存在 → SESSION_NOT_FOUND(404)；
   * thread 记录缺失（会话有、harness 侧没有）→ 没什么可停，返回 cancelled: 0。
   */
  async cancelRun(sessionId: string, userId: string): Promise<{ cancelled: number }> {
    const owned = await this.deps.chatSessions.isOwned(sessionId, userId);
    if (!owned) throw new AppError('Session not found', 'SESSION_NOT_FOUND', 404);

    try {
      const threadService = await this.deps.getThreadService();
      const { cancelled } = await threadService.cancelRun({
        thread_id: sessionId,
        user_id: userId,
      });
      return { cancelled };
    } catch (error) {
      if (error instanceof ThreadServiceError && error.code === 'NOT_FOUND') {
        return { cancelled: 0 };
      }
      throw error;
    }
  }

  // ---- 删除会话 ----

  /**
   * 整体删除会话：
   *  1. 事务内：捞 MinIO keys（file_metadata 行会随 chat_message 级联消失，对象不在
   *     事务里，先捞出）→ 删 chat_message → 删 chat_session（0 行 → SESSION_NOT_FOUND
   *     回滚，404）。
   *  2. commit 后清理 agent 侧数据（threads_meta / runs / checkpoint / 沙箱容器）——
   *     若此刻还有 run 在跑，deleteThread 会先取消并等收尾，否则 run 会在清理之后
   *     继续写 checkpoint，把刚删掉的数据写回来。失败只告警，不影响删除结果。
   *  3. MinIO 对象与 file_content：只删「已无任何会话引用」的对象（同一 fileId 可在
   *     多个会话出现），单键失败只告警 —— 删不掉不该把「对话已删除」反悔成 500。
   */
  async deleteSession(sessionId: string, userId: string): Promise<ChatSessionRecord> {
    let fileKeys: string[] = [];

    const deleted = await withTransaction(async (db) => {
      fileKeys = await this.deps.fileMetadata.minioKeysForSessionDelete(sessionId, db);
      await this.deps.chatMessages.deleteBySession(sessionId, userId, db);
      const session = await this.deps.chatSessions.deleteOwned(sessionId, userId, db);
      if (!session) throw new AppError('Session not found', 'SESSION_NOT_FOUND', 404);
      return session;
    });

    try {
      const threadService = await this.deps.getThreadService();
      await threadService.deleteThread({ thread_id: sessionId, user_id: userId });
    } catch (error) {
      console.warn(
        `[DELETE session] agent-side cleanup failed for ${sessionId}:`,
        error instanceof Error ? error.message : error,
      );
    }

    await this.cleanupSessionFiles(fileKeys);

    return deleted;
  }

  /** 删除会话关联的上传文件：引用计数 GC（见 deleteSession 第 3 步说明）。 */
  private async cleanupSessionFiles(minioKeys: string[]): Promise<void> {
    if (minioKeys.length === 0) return;

    let stillReferenced: string[];
    try {
      stillReferenced = await this.deps.fileMetadata.stillReferenced(minioKeys);
    } catch (error) {
      // 查不清引用关系就不动对象：宁可留垃圾，不能误删别处还在用的文件
      console.warn(
        '[DELETE session] failed to check file references, skip object removal:',
        error instanceof Error ? error.message : error,
      );
      return;
    }

    const removable = minioKeys.filter((key) => !stillReferenced.includes(key));
    if (removable.length === 0) return;

    for (const key of removable) {
      try {
        await this.deps.deleteFile(key);
      } catch (error) {
        console.warn(
          `[DELETE session] failed to remove object ${key}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    try {
      await this.deps.fileContent.deleteByMinioKeys(removable);
    } catch (error) {
      console.warn(
        '[DELETE session] failed to delete file_content rows:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  // ---- run 终态等待 ----

  /**
   * 取某 run 的 error 文本（用于判断这轮是不是被取消），run 不存在返回 null。
   *
   * 为什么要等：客户端「停止」的时序是先 abort 本地 SSE、再 POST cancel_run，所以断流
   * 那一刻 run 往往还是 running —— 不等终态就把 assistant 消息落库，取消标记永远写
   * 不上去。正常跑完的场景状态早已是终态，不会产生等待。超时（默认 1s）按「未取消」处理。
   */
  async waitRunError(runId: string, timeoutMs = 1000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await this.deps.runStore.get(runId);
      if (!run) return null;
      if (run.status !== 'running' && run.status !== 'pending') return run.error ?? null;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export function createConversationService(
  deps?: Partial<ConversationServiceDeps>,
): ConversationService {
  return new ConversationService({
    chatSessions: deps?.chatSessions ?? new PgChatSessionStore(),
    chatMessages: deps?.chatMessages ?? new PgChatMessageStore(),
    fileMetadata: deps?.fileMetadata ?? new PgFileMetadataStore(),
    fileContent: deps?.fileContent ?? new PgFileContentStore(),
    runStore: deps?.runStore ?? getRunStore(),
    getThreadService: deps?.getThreadService ?? getThreadService,
    deleteFile: deps?.deleteFile ?? deleteFile,
  });
}

// 模块级懒单例即可：本服务无状态（状态都在 store / wiring 里），不需要 globalThis
// 的防 HMR 分裂措施；真加可变状态时再换 globalThis 模式。
let service: ConversationService | null = null;

export function getConversationService(): ConversationService {
  if (!service) service = createConversationService();
  return service;
}
