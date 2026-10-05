import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/services/model-config-service', () => ({
  resolveUserModelConfig: vi.fn(),
}));

import type { ModelConfig, ThreadService } from '@/deerflow-harness';
import type { MessagePart } from '@/types';
import type { SavedFileMetadata } from '@/server/daos/file-metadata';
import { resolveUserModelConfig } from '@/server/services/model-config-service';
import type { ChatSessionRecord } from '@/server/daos/chat-session';
import { ChatSessionAccessError } from '@/server/daos/chat-session';
import type { ChatContentBlock, ChatStreamBody } from '@/server/validation/schemas';
import {
  ChatService,
  cancelledMarkerText,
  contentsToUserParts,
  pickEarlier,
  pickFileIds,
  pickInputText,
  resolveRunMetadata,
  toThreadImages,
  userPartsToContents,
} from '../chat-service';
import type { ConversationService } from '../conversation-service';

const MODEL_CONFIG = {} as unknown as ModelConfig;

const SESSION: ChatSessionRecord = {
  id: 'sess-1',
  seq_id: 1,
  title: 't',
  created_at: 1,
  updated_at: 1,
};

const TEXT = (text: string): ChatContentBlock => ({ type: 'text', text });
const FILE = (fileId: string): ChatContentBlock => ({ type: 'file', fileId });
const IMAGE = (fileId: string): ChatContentBlock => ({ type: 'image', fileId });

function makeBody(over: Partial<ChatStreamBody> = {}): ChatStreamBody {
  return {
    message: { contents: [TEXT('hello')] },
    ...over,
  };
}

function makeDeps() {
  const conversations = {
    resolveFilesByIds: vi.fn(async () => []),
    ensureSession: vi.fn(async () => SESSION),
    getLatestMessageByRole: vi.fn(async () => null),
    getLatestUserMessageWithParts: vi.fn(async () => null),
    deleteMessagesAtOrAfter: vi.fn(async () => {}),
    saveUserMessage: vi.fn(async () => ({ messageId: 'um1' })),
    getLatestAssistantWithParts: vi.fn(async () => null),
    waitRunError: vi.fn(async () => null),
    saveAssistantMessage: vi.fn(async () => ({ messageId: 'am1' })),
    updateAssistantParts: vi.fn(async () => {}),
  } as unknown as ConversationService;

  const threadService = {
    createThread: vi.fn(async () => {}),
    truncateHistory: vi.fn(async () => ({ truncated: true })),
    submitRun: vi.fn(async () => ({ run_id: 'r1' })),
    resume: vi.fn(async () => ({ run_id: 'r2' })),
    subscribe: vi.fn(() => (async function* () {})()),
    cancelRun: vi.fn(),
    deleteThread: vi.fn(),
  } as unknown as ThreadService;

  return { conversations, threadService, getThreadService: vi.fn(async () => threadService) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveUserModelConfig).mockResolvedValue({
    ok: true,
    modelConfig: MODEL_CONFIG,
    presetKey: 'qwen-max',
  });
});

// ---- 纯函数 ----

describe('pickInputText', () => {
  it('按序拼接全部 text block 并 trim', () => {
    expect(pickInputText([TEXT('第一段'), FILE('f1'), TEXT(' 第二段 ')])).toBe('第一段\n 第二段');
  });

  it('无 text → 空串', () => {
    expect(pickInputText([FILE('f1')])).toBe('');
  });
});

describe('pickFileIds', () => {
  it('按视觉顺序收集 file/image 的 fileId', () => {
    expect(pickFileIds([FILE('f1'), TEXT('x'), IMAGE('i1'), FILE('f2')])).toEqual([
      'f1',
      'i1',
      'f2',
    ]);
  });
});

describe('contentsToUserParts', () => {
  it('保持块顺序；file/image 写入 resolved 元信息；空 text 跳过', () => {
    const parts = contentsToUserParts(
      [TEXT('a'), TEXT(''), FILE('f1')],
      [
        {
          fileId: 'f1',
          filename: '报告.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10,
          minioKey: 'k1',
        },
      ],
    );

    expect(parts.map((p) => p.type)).toEqual(['text', 'file']);
    const filePart = parts[1] as MessagePart & {
      content: { fileId?: string; filename?: string };
    };
    expect(filePart.content).toMatchObject({
      fileId: 'f1',
      filename: '报告.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
    });
  });

  it('未解析到的 file 块降级为仅 fileId（filename 等为 undefined）', () => {
    const parts = contentsToUserParts([IMAGE('i-missing')], []);
    const content = (parts[0] as MessagePart & { content: Record<string, unknown> }).content;
    expect(content.fileId).toBe('i-missing');
    expect(content.filename).toBeUndefined();
  });
});

describe('userPartsToContents', () => {
  it('text/file/image part 按原顺序还原为 contents 块', () => {
    const parts = [
      { partId: 'p1', type: 'text', createdAt: 1, content: { text: '问题' } },
      { partId: 'p2', type: 'file', createdAt: 1, content: { fileId: 'f1' } },
      { partId: 'p3', type: 'image', createdAt: 1, content: { fileId: 'i1' } },
    ];
    expect(userPartsToContents(parts as MessagePart[])).toEqual([
      { type: 'text', text: '问题' },
      { type: 'file', fileId: 'f1' },
      { type: 'image', fileId: 'i1' },
    ]);
  });

  it('content 缺失或 fileId 非字符串的 part 跳过（不产出半截块）', () => {
    const parts = [
      { partId: 'p1', type: 'text', createdAt: 1 },
      { partId: 'p2', type: 'file', createdAt: 1, content: { fileId: 123 } },
    ];
    expect(userPartsToContents(parts as unknown as MessagePart[])).toEqual([]);
  });
});

describe('toThreadImages', () => {
  it('仅 image/* 进入视觉引用，字段映射为 ThreadImageRef', () => {
    const files: SavedFileMetadata[] = [
      { fileId: 'i1', filename: 'p.png', mimeType: 'image/png', sizeBytes: 10, minioKey: 'k1' },
      {
        fileId: 'f1',
        filename: 'r.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 20,
        minioKey: 'k2',
      },
    ];
    expect(toThreadImages(files)).toEqual([
      { fileId: 'i1', filename: 'p.png', mimeType: 'image/png', minioKey: 'k1', sizeBytes: 10 },
    ]);
  });
});

describe('pickEarlier', () => {
  it('取较早时刻；缺一侧取另一侧', () => {
    const a = new Date('2026-01-02T00:00:00Z');
    const b = new Date('2026-01-01T00:00:00Z');
    expect(pickEarlier(a, b)).toBe(b);
    expect(pickEarlier(a, undefined)).toBe(a);
    expect(pickEarlier(undefined, b)).toBe(b);
    expect(pickEarlier(undefined, undefined)).toBeUndefined();
  });
});

describe('cancelledMarkerText', () => {
  it('三种取消原因 → 三种文案', () => {
    expect(cancelledMarkerText('cancelled: stopped by user')).toBe('用户已取消');
    expect(cancelledMarkerText('cancelled: superseded by a new run')).toBe('已被新消息取代');
    expect(cancelledMarkerText('cancelled: thread deleted')).toBe('本轮已取消');
  });

  it('中间件链前缀不掩盖取消（includes 而非 startsWith）', () => {
    expect(
      cancelledMarkerText(
        'Error in middleware "SubagentLimitMiddleware": cancelled: stopped by user',
      ),
    ).toBe('用户已取消');
  });

  it('非取消错误 / null → null', () => {
    expect(cancelledMarkerText('provider timeout')).toBeNull();
    expect(cancelledMarkerText(null)).toBeNull();
  });
});

describe('resolveRunMetadata', () => {
  it('无 configuration → undefined（走 baseOptions 默认）', () => {
    expect(resolveRunMetadata(undefined)).toBeUndefined();
    expect(resolveRunMetadata(null)).toBeUndefined();
  });

  it('memoryEnabled 仅严格 boolean 生效', () => {
    expect(resolveRunMetadata({ memoryEnabled: true })).toEqual({ memoryEnabled: true });
    expect(resolveRunMetadata({ memoryEnabled: false })).toEqual({ memoryEnabled: false });
    expect(resolveRunMetadata({ memoryEnabled: 'yes' })).toBeUndefined();
  });

  it('memoryMode 仅两个合法字面量生效', () => {
    expect(resolveRunMetadata({ memoryMode: 'retrieve' })).toEqual({ memoryMode: 'retrieve' });
    expect(resolveRunMetadata({ memoryMode: 'inject' })).toEqual({ memoryMode: 'inject' });
    expect(resolveRunMetadata({ memoryMode: 'banana' })).toBeUndefined();
  });

  it('两开关同时出现时都透传', () => {
    expect(resolveRunMetadata({ memoryEnabled: false, memoryMode: 'retrieve' })).toEqual({
      memoryEnabled: false,
      memoryMode: 'retrieve',
    });
  });
});

// ---- prepare ----

describe('prepare', () => {
  it('无选中模型 → 400 no_model_selected，且不建会话（模型预检在 ensureSession 之前）', async () => {
    const { conversations, getThreadService } = makeDeps();
    vi.mocked(resolveUserModelConfig).mockResolvedValueOnce({
      ok: false,
      reason: 'NO_MODEL',
    });

    const svc = new ChatService({
      conversations,
      getThreadService,
    });
    const result = await svc.prepare({ userId: 'u1', body: makeBody() });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { body: Record<string, unknown> }).body.error).toBe('no_model_selected');
    expect(conversations.ensureSession).not.toHaveBeenCalled();
  });

  it('缺 Key → 400 no_api_key 且携带 provider', async () => {
    const { conversations, getThreadService } = makeDeps();
    vi.mocked(resolveUserModelConfig).mockResolvedValueOnce({
      ok: false,
      reason: 'NO_KEY',
      provider: 'qwen',
    });

    const svc = new ChatService({ conversations, getThreadService });
    const result = await svc.prepare({ userId: 'u1', body: makeBody() });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { body: Record<string, unknown> }).body).toMatchObject({
      error: 'no_api_key',
      provider: 'qwen',
    });
  });

  it('会话属于他人 → 403 forbidden', async () => {
    const { conversations, getThreadService } = makeDeps();
    (conversations.ensureSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ChatSessionAccessError('belongs to another user'),
    );

    const svc = new ChatService({ conversations, getThreadService });
    const result = await svc.prepare({ userId: 'u1', body: makeBody({ sessionId: 'sess-1' }) });

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect((result as { body: Record<string, unknown> }).body.error).toBe('forbidden');
  });

  it('正常发送：写 user message、预生成 assistantMessageId、runMetadata 严格判定', async () => {
    const { conversations, getThreadService, threadService } = makeDeps();

    const svc = new ChatService({ conversations, getThreadService });
    const result = await svc.prepare({
      userId: 'u1',
      body: makeBody({ configuration: { memoryEnabled: true } }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.threadId).toBe('sess-1');
    expect(result.prepared.runMetadata).toEqual({ memoryEnabled: true });
    expect(conversations.saveUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', userId: 'u1' }),
    );
    expect(typeof result.prepared.assistantMessageId).toBe('string');

    const submitted = await svc.submit(result.prepared);
    expect(submitted).toMatchObject({ ok: true });
    expect(threadService.submitRun).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: 'sess-1',
        user_id: 'u1',
        input: 'hello',
        modelConfig: MODEL_CONFIG,
        metadata: { memoryEnabled: true },
      }),
    );
    expect(threadService.truncateHistory).not.toHaveBeenCalled();
  });

  it('recall：先截 checkpoint 再截 DB，自最近 assistant 消息起，不写 user message', async () => {
    const { conversations, getThreadService, threadService } = makeDeps();
    const createdAt = new Date('2026-01-01T00:00:00Z');
    (conversations.getLatestMessageByRole as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'a1',
      role: 'assistant',
      createdAt,
    });

    const svc = new ChatService({ conversations, getThreadService });
    const result = await svc.prepare({
      userId: 'u1',
      body: makeBody({ sessionId: 'sess-1', operation: 'recall' }),
    });

    expect(result.ok).toBe(true);
    expect(threadService.truncateHistory).toHaveBeenCalledWith({
      thread_id: 'sess-1',
      user_id: 'u1',
    });
    // checkpoint 截断在 DB 截断之前：失败时 DB 原封不动，重试不会多删
    expect(
      (threadService.truncateHistory as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    ).toBeLessThan(
      (conversations.deleteMessagesAtOrAfter as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    );
    expect(conversations.deleteMessagesAtOrAfter).toHaveBeenCalledWith('sess-1', createdAt);
    expect(conversations.saveUserMessage).not.toHaveBeenCalled();
  });

  it('recall：输入覆盖为原始提问并重放其附件，先读原始提问再截断', async () => {
    const { conversations, getThreadService, threadService } = makeDeps();
    const createdAt = new Date('2026-01-01T00:00:00Z');
    (conversations.getLatestUserMessageWithParts as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      {
        id: 'u1',
        createdAt,
        parts: [
          { partId: 'p1', type: 'text', createdAt: 1, content: { text: '原始问题' } },
          { partId: 'p2', type: 'image', createdAt: 1, content: { fileId: 'img-1' } },
        ],
      },
    );
    (conversations.resolveFilesByIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        fileId: 'img-1',
        filename: 'p.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        minioKey: 'k1',
      },
    ]);
    (conversations.getLatestMessageByRole as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'a1',
      role: 'assistant',
      createdAt,
    });

    const svc = new ChatService({ conversations, getThreadService });
    const result = await svc.prepare({
      userId: 'u1',
      body: makeBody({ sessionId: 'sess-1', operation: 'recall' }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 必须先读原始提问再截断：截断落在提问之后，读晚了数据就没了
    expect(
      (conversations.getLatestUserMessageWithParts as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      (conversations.deleteMessagesAtOrAfter as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    );
    expect(conversations.deleteMessagesAtOrAfter).toHaveBeenCalledWith('sess-1', createdAt);
    expect(conversations.saveUserMessage).not.toHaveBeenCalled();

    // 请求体正文（回答原文）被原始提问覆盖；原始附件重放为视觉引用
    await svc.submit(result.prepared);
    expect(threadService.submitRun).toHaveBeenCalledWith(
      expect.objectContaining({
        input: '原始问题',
        images: [
          {
            fileId: 'img-1',
            filename: 'p.png',
            mimeType: 'image/png',
            minioKey: 'k1',
            sizeBytes: 10,
          },
        ],
      }),
    );
  });

  it('reEditCall：截断自最近 user/assistant 中较早者', async () => {
    const { conversations, getThreadService, threadService } = makeDeps();
    const assistantAt = new Date('2026-01-02T00:00:00Z');
    const userAt = new Date('2026-01-01T00:00:00Z');
    (conversations.getLatestMessageByRole as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'a1', role: 'assistant', createdAt: assistantAt })
      .mockResolvedValueOnce({ id: 'u1', role: 'user', createdAt: userAt });

    const svc = new ChatService({ conversations, getThreadService });
    const result = await svc.prepare({
      userId: 'u1',
      body: makeBody({ sessionId: 'sess-1', operation: 'reEditCall' }),
    });

    expect(result.ok).toBe(true);
    expect(threadService.truncateHistory).toHaveBeenCalledWith({
      thread_id: 'sess-1',
      user_id: 'u1',
    });
    expect(conversations.deleteMessagesAtOrAfter).toHaveBeenCalledWith('sess-1', userAt);
    // reEditCall 要写新的 user message
    expect(conversations.saveUserMessage).toHaveBeenCalled();
  });

  it('resume：不写 DB、复用既有 assistant 消息作 seed、submit 走 resume', async () => {
    const { conversations, getThreadService, threadService } = makeDeps();
    (conversations.getLatestAssistantWithParts as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'am-seed',
      parts: [{ partId: 'p1', type: 'text', createdAt: 1, content: { text: 'seed' } }],
    });

    const svc = new ChatService({ conversations, getThreadService });
    const result = await svc.prepare({
      userId: 'u1',
      body: makeBody({ sessionId: 'sess-1', operation: 'resume' }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(conversations.saveUserMessage).not.toHaveBeenCalled();
    expect(result.prepared.shouldUpdateOnResume).toBe(true);
    expect(result.prepared.assistantMessageId).toBe('am-seed');
    expect(result.prepared.resumeSeedParts).toHaveLength(1);

    await svc.submit(result.prepared);
    expect(threadService.resume).toHaveBeenCalledWith(
      expect.objectContaining({ thread_id: 'sess-1', decision: 'hello' }),
    );
    expect(threadService.submitRun).not.toHaveBeenCalled();
    expect(threadService.truncateHistory).not.toHaveBeenCalled();
  });
});
