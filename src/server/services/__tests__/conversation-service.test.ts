import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  getClient: vi.fn(),
  query: vi.fn(),
}));

import { getClient } from '@/lib/db';
import type { MessagePart } from '@/types';
import { ThreadServiceError } from '@/deerflow-harness';
import type { ChatMessageStore } from '@/server/daos/chat-message';
import type { ChatSessionRecord, ChatSessionStore } from '@/server/daos/chat-session';
import type { FileContentStore } from '@/server/daos/file-content';
import type { FileMetadataStore } from '@/server/daos/file-metadata';
import { ConversationService } from '../conversation-service';
import type { ConversationServiceDeps } from '../conversation-service';

/** 事务内 store 调用与 BEGIN/COMMIT 共享同一顺序轨迹，用于断言编排次序。 */
function makeFakeClient(order: string[]) {
  const client = {
    query: vi.fn(async (sql: string) => {
      order.push(sql);
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return client;
}

const SESSION: ChatSessionRecord = {
  id: 's1',
  seq_id: 1,
  title: 't',
  created_at: 1,
  updated_at: 1,
};

function makeDeps(order: string[]): {
  deps: ConversationServiceDeps;
  client: ReturnType<typeof makeFakeClient>;
} {
  const client = makeFakeClient(order);
  const deps = {
    chatSessions: {
      isOwned: vi.fn(async () => {
        order.push('chatSessions.isOwned');
        return true;
      }),
      deleteOwned: vi.fn(async () => {
        order.push('chatSessions.deleteOwned');
        return SESSION;
      }),
      updateTitle: vi.fn(),
      ensureOwned: vi.fn(),
      listByUser: vi.fn(),
      getOwned: vi.fn(),
      nextSeqId: vi.fn(),
      create: vi.fn(),
    } as unknown as ChatSessionStore,
    chatMessages: {
      insert: vi.fn(async () => {
        order.push('chatMessages.insert');
        return { messageId: 'm1' };
      }),
      updateParts: vi.fn(),
      deleteAtOrAfter: vi.fn(),
      getLatestByRole: vi.fn(),
      getLatestAssistantWithParts: vi.fn(),
      listBySession: vi.fn(async () => {
        order.push('chatMessages.listBySession');
        return [];
      }),
      deleteBySession: vi.fn(async () => {
        order.push('chatMessages.deleteBySession');
      }),
    } as unknown as ChatMessageStore,
    fileMetadata: {
      insertMany: vi.fn(async () => {
        order.push('fileMetadata.insertMany');
      }),
      listBySession: vi.fn(async () => {
        order.push('fileMetadata.listBySession');
        return [];
      }),
      minioKeysForSessionDelete: vi.fn(async () => {
        order.push('fileMetadata.minioKeysForSessionDelete');
        return ['k1', 'k2'];
      }),
      stillReferenced: vi.fn(async () => {
        order.push('fileMetadata.stillReferenced');
        return ['k2'];
      }),
      getByFileId: vi.fn(),
      deleteByFileId: vi.fn(),
    } as unknown as FileMetadataStore,
    fileContent: {
      insertParsing: vi.fn(),
      markSuccess: vi.fn(),
      markFailed: vi.fn(),
      getByIds: vi.fn(),
      getMinioKeysLike: vi.fn(),
      deleteByMinioKey: vi.fn(),
      deleteByMinioKeys: vi.fn(async () => {
        order.push('fileContent.deleteByMinioKeys');
      }),
    } as unknown as FileContentStore,
    runStore: { get: vi.fn(async () => null) },
    getThreadService: vi.fn(async () => ({
      deleteThread: vi.fn(async () => {
        order.push('threadService.deleteThread');
      }),
      cancelRun: vi.fn(async () => ({ cancelled: 2 })),
    })),
    deleteFile: vi.fn(async (key: string) => {
      order.push(`deleteFile(${key})`);
    }),
  } as unknown as ConversationServiceDeps;
  return { deps, client };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('saveUserMessage', () => {
  it('在事务内依次写 chat_message 与 file_metadata，成功后 COMMIT', async () => {
    const order: string[] = [];
    const { deps, client } = makeDeps(order);
    vi.mocked(getClient).mockResolvedValue(client as never);

    const svc = new ConversationService(deps);
    await svc.saveUserMessage({
      sessionId: 's1',
      userId: 'u1',
      // parts 内容与断言无关（service 只做 JSON 序列化落库），形状在此不校验
      parts: [{ type: 'text', text: 'hi' }] as unknown as MessagePart[],
      uploadedFiles: [
        {
          fileId: 'f1',
          filename: 'a.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1,
          minioKey: 'k',
        },
      ],
    });

    expect(order).toEqual(['BEGIN', 'chatMessages.insert', 'fileMetadata.insertMany', 'COMMIT']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('消息插入失败时 ROLLBACK 并 rethrow', async () => {
    const order: string[] = [];
    const { deps, client } = makeDeps(order);
    vi.mocked(getClient).mockResolvedValue(client as never);
    (deps.chatMessages.insert as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      order.push('chatMessages.insert');
      throw new Error('fk');
    });

    const svc = new ConversationService(deps);
    await expect(svc.saveUserMessage({ sessionId: 's1', userId: 'u1', parts: [] })).rejects.toThrow(
      'fk',
    );

    expect(order).toEqual(['BEGIN', 'chatMessages.insert', 'ROLLBACK']);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('deleteSession', () => {
  it('事务内：捞 keys → 删消息 → 删会话行；commit 后：agent 数据 → 引用 GC → 逐键删对象 → 删 file_content', async () => {
    const order: string[] = [];
    const { deps, client } = makeDeps(order);
    vi.mocked(getClient).mockResolvedValue(client as never);

    const svc = new ConversationService(deps);
    const deleted = await svc.deleteSession('s1', 'u1');

    expect(deleted).toBe(SESSION);
    expect(order).toEqual([
      'BEGIN',
      'fileMetadata.minioKeysForSessionDelete',
      'chatMessages.deleteBySession',
      'chatSessions.deleteOwned',
      'COMMIT',
      'threadService.deleteThread',
      'fileMetadata.stillReferenced',
      'deleteFile(k1)', // k2 仍被别的会话引用，不删
      'fileContent.deleteByMinioKeys',
    ]);
    // 引用判定与批量删除只含可删的 k1
    expect(deps.fileMetadata.stillReferenced).toHaveBeenCalledWith(['k1', 'k2']);
    expect(deps.fileContent.deleteByMinioKeys).toHaveBeenCalledWith(['k1']);
  });

  it('会话行 0 行 → ROLLBACK，后置清理（agent 数据 / 文件对象）全部不触发，抛 SESSION_NOT_FOUND', async () => {
    const order: string[] = [];
    const { deps, client } = makeDeps(order);
    vi.mocked(getClient).mockResolvedValue(client as never);
    (deps.chatSessions.deleteOwned as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      order.push('chatSessions.deleteOwned');
      return null;
    });

    const svc = new ConversationService(deps);
    await expect(svc.deleteSession('s1', 'u1')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
    });

    expect(order).toEqual([
      'BEGIN',
      'fileMetadata.minioKeysForSessionDelete',
      'chatMessages.deleteBySession',
      'chatSessions.deleteOwned',
      'ROLLBACK',
    ]);
    expect(deps.getThreadService).not.toHaveBeenCalled();
    expect(deps.deleteFile).not.toHaveBeenCalled();
  });

  it('单个对象删除失败只告警，不影响其余清理', async () => {
    const order: string[] = [];
    const { deps, client } = makeDeps(order);
    vi.mocked(getClient).mockResolvedValue(client as never);
    (deps.deleteFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('minio down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const svc = new ConversationService(deps);
    await expect(svc.deleteSession('s1', 'u1')).resolves.toBe(SESSION);

    expect(warnSpy).toHaveBeenCalled();
    expect(deps.fileContent.deleteByMinioKeys).toHaveBeenCalledWith(['k1']);
    warnSpy.mockRestore();
  });
});

describe('cancelRun', () => {
  it('会话不属于该用户 → SESSION_NOT_FOUND(404)', async () => {
    const order: string[] = [];
    const { deps } = makeDeps(order);
    (deps.chatSessions.isOwned as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    const svc = new ConversationService(deps);
    await expect(svc.cancelRun('s1', 'u1')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
    });
  });

  it('thread 记录缺失（NOT_FOUND）→ 幂等返回 cancelled: 0', async () => {
    const order: string[] = [];
    const { deps } = makeDeps(order);
    (deps.getThreadService as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      cancelRun: vi.fn(async () => {
        throw new ThreadServiceError('thread not found', 'NOT_FOUND');
      }),
    });

    const svc = new ConversationService(deps);
    await expect(svc.cancelRun('s1', 'u1')).resolves.toEqual({ cancelled: 0 });
  });

  it('正常取消透传 cancelled 计数', async () => {
    const order: string[] = [];
    const { deps } = makeDeps(order);

    const svc = new ConversationService(deps);
    await expect(svc.cancelRun('s1', 'u1')).resolves.toEqual({ cancelled: 2 });
  });
});

describe('waitRunError', () => {
  it('轮询到终态后返回 error 文本', async () => {
    const order: string[] = [];
    const { deps } = makeDeps(order);
    (deps.runStore.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ status: 'running', error: null })
      .mockResolvedValueOnce({ status: 'failed', error: 'cancelled: superseded by a new run' });

    const svc = new ConversationService(deps);
    await expect(svc.waitRunError('r1', 1000)).resolves.toBe('cancelled: superseded by a new run');
    expect(deps.runStore.get).toHaveBeenCalledTimes(2);
  });

  it('run 不存在 → null', async () => {
    const order: string[] = [];
    const { deps } = makeDeps(order);

    const svc = new ConversationService(deps);
    await expect(svc.waitRunError('r1')).resolves.toBeNull();
  });
});

describe('loadSessionHistory', () => {
  it('会话不属于该用户 → 空数组且不查消息', async () => {
    const order: string[] = [];
    const { deps } = makeDeps(order);
    (deps.chatSessions.isOwned as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    const svc = new ConversationService(deps);
    await expect(svc.loadSessionHistory('s1', 'u1')).resolves.toEqual([]);
    expect(deps.chatMessages.listBySession).not.toHaveBeenCalled();
  });
});
