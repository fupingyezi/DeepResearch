/**
 * /api/v3/chat —— 单一聊天入口
 *
 * 协议（请求体）：
 *   POST application/json
 *   {
 *     "sessionId"?: string,                       // 缺省 = 新建会话；存在 = 已有会话
 *     "configuration"?: {
 *       "model"?: { "value"?: string }            // 替代旧的 metadata.modelKey
 *     },
 *     "message": {
 *       "contents": Array<
 *         | { "type": "text",  "text": string }
 *         | { "type": "file",  "fileId": string }
 *         | { "type": "image", "fileId": string }
 *       >
 *     },
 *     "stream"?: true,
 *     "operation"?: "resume" | "recall" | "reEditCall"
 *   }
 *
 * Response：
 *   text/event-stream，载荷为 ClientAgentEvent。
 *
 * 消息持久化（前端不再写 DB；本路由统一处理）：
 *   - undefined（普通发送）：写 user message + END 时写 assistant message
 *   - recall：定位最近 assistant，截断 → 重生 assistant；保留原 user
 *   - reEditCall：定位最近一对 user+assistant，全部截断 → 写新 user → 重生 assistant
 *   - resume：不写 DB（保留原行为）
 */

import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';

import {
  ClientAgentEventType,
  createClientAgentEvent,
  createSseStream,
  type ClientAgentEvent,
} from '@/deerflow-harness';
import type { MessagePart, ChatMessageType } from '@/types';
import { getThreadService, getDeerFlowClientWithModelConfig } from '../../threads/_service';
import {
  createChatSessionRecord,
  insertAssistantMessageRecord,
  insertUserMessageRecord,
  resolveFilesByIds,
  deleteMessagesAtOrAfter,
  getLatestMessageByRole,
  type ChatSessionRecord,
  type SavedFileMetadata,
} from '../../conversations/_service';
import { AssistantPartsCollector } from './_parts-collector';

// ============================================================================
// 协议类型
// ============================================================================

type TextBlock = { type: 'text'; text: string };
type FileBlock = { type: 'file'; fileId: string };
type ImageBlock = { type: 'image'; fileId: string };
type ContentBlock = TextBlock | FileBlock | ImageBlock;

interface ChatStreamBody {
  sessionId?: string;
  configuration?: {
    model?: { value?: string };
    [k: string]: unknown;
  } | null;
  message: { contents: ContentBlock[] };
  stream?: true;
  operation?: 'resume' | 'recall' | 'reEditCall';
}

// ============================================================================
// 工具
// ============================================================================

const pickUserId = (req: NextRequest): string | undefined =>
  req.headers.get('x-user-id') ?? undefined;

function pickInputText(contents: ContentBlock[]): string {
  const segments: string[] = [];
  for (const block of contents) {
    if (block && block.type === 'text' && typeof block.text === 'string') segments.push(block.text);
  }
  return segments.join('\n').trim();
}

function pickFileIds(contents: ContentBlock[]): string[] {
  const ids: string[] = [];
  for (const block of contents) {
    if (
      block &&
      (block.type === 'file' || block.type === 'image') &&
      typeof block.fileId === 'string' &&
      block.fileId.length > 0
    ) {
      ids.push(block.fileId);
    }
  }
  return ids;
}

function isValidContents(value: unknown): value is ContentBlock[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((block) => {
    if (!block || typeof block !== 'object') return false;
    const b = block as Record<string, unknown>;
    if (b.type === 'text') return typeof b.text === 'string';
    if (b.type === 'file' || b.type === 'image')
      return typeof b.fileId === 'string' && (b.fileId as string).length > 0;
    return false;
  });
}

/**
 * 把 message.contents 转换为 user message 的 parts[]：
 * - text  → text part（多个 text block 各自独立 part；前端历史展示按时序拼接）
 * - file  → file part（resolved file 元信息一并写入 content）
 * - image → image part
 */
function contentsToUserParts(
  contents: ContentBlock[],
  resolvedFiles: SavedFileMetadata[],
): MessagePart[] {
  const fileById = new Map<string, SavedFileMetadata>();
  for (const file of resolvedFiles) fileById.set(file.fileId, file);

  const now = Date.now();
  const parts: MessagePart[] = [];
  for (const block of contents) {
    if (block.type === 'text') {
      if (block.text.length === 0) continue;
      parts.push({
        partId: uuidv4(),
        type: 'text',
        createdAt: now,
        content: { text: block.text },
      });
    } else if (block.type === 'file' || block.type === 'image') {
      const meta = fileById.get(block.fileId);
      parts.push({
        partId: uuidv4(),
        type: block.type,
        createdAt: now,
        content: {
          fileId: block.fileId,
          filename: meta?.filename,
          mimeType: meta?.mimeType,
          sizeBytes: meta?.sizeBytes,
        },
      });
    }
  }
  return parts;
}

// ============================================================================
// 路由实现
// ============================================================================

export async function POST(request: NextRequest) {
  const user_id = pickUserId(request);

  const body = (await request.json().catch(() => ({}))) as ChatStreamBody;

  if (!body || !body.message || !isValidContents(body.message.contents)) {
    return new Response(JSON.stringify({ error: 'invalid message.contents' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const operation = body.operation;
  const isResume = operation === 'resume';
  const isRecall = operation === 'recall';
  const isReEdit = operation === 'reEditCall';
  const shouldPersistMessages = !isResume;

  const contents = body.message.contents;
  const inputText = pickInputText(contents);
  if (!inputText) {
    return new Response(
      JSON.stringify({ error: 'message.contents must contain at least one text block' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const fileIds = pickFileIds(contents);
  let resolvedFiles: SavedFileMetadata[] = [];
  if (fileIds.length > 0) {
    try {
      resolvedFiles = await resolveFilesByIds(fileIds);
    } catch (e) {
      console.error('[POST /api/v3/chat] resolveFilesByIds failed:', e, { fileIds });
    }
  }

  // —— sessionId 分流 ——
  const incomingSessionId =
    typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : null;

  let resolvedThreadId = incomingSessionId ?? '';
  let createdChatSession: ChatSessionRecord | null = null;

  if (!incomingSessionId) {
    try {
      const title = inputText.slice(0, 15) || 'New thread';
      createdChatSession = await createChatSessionRecord({ title });
      resolvedThreadId = createdChatSession.id;
    } catch (e) {
      console.error('[POST /api/v3/chat] createChatSessionRecord failed:', e);
      return new Response(
        JSON.stringify({
          error: 'failed to create chat session',
          message: (e as Error)?.message,
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  const hasModelValue =
    typeof body.configuration?.model?.value === 'string' &&
    body.configuration.model.value.length > 0;
  const dynamicClient = hasModelValue
    ? await getDeerFlowClientWithModelConfig(body.configuration ?? undefined)
    : null;

  // —— 幂等创建 thread ——
  try {
    const threadService = await getThreadService();
    await threadService.createThread({
      thread_id: resolvedThreadId,
      user_id,
      display_name: inputText.slice(0, 15) || 'New thread',
    });
  } catch (e) {
    console.error('[POST /api/v3/chat] createThread failed:', e);
    return new Response(
      JSON.stringify({
        error: 'failed to create thread',
        message: (e as Error)?.message,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // —— recall / reEditCall 截断 ——
  if (shouldPersistMessages && (isRecall || isReEdit)) {
    try {
      if (isRecall) {
        const lastAssistant = await getLatestMessageByRole(resolvedThreadId, 'assistant');
        if (lastAssistant) {
          await deleteMessagesAtOrAfter(resolvedThreadId, lastAssistant.createdAt);
        }
      } else {
        // reEditCall：删除最近一对 user+assistant
        const lastAssistant = await getLatestMessageByRole(resolvedThreadId, 'assistant');
        const lastUser = await getLatestMessageByRole(resolvedThreadId, 'user');
        const cutoff = pickEarlier(lastAssistant?.createdAt, lastUser?.createdAt);
        if (cutoff) {
          await deleteMessagesAtOrAfter(resolvedThreadId, cutoff);
        }
      }
    } catch (e) {
      console.error('[POST /api/v3/chat] truncate before retry failed:', e);
      return new Response(
        JSON.stringify({
          error: 'failed to truncate previous messages',
          message: (e as Error)?.message,
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  // —— 写入 user message（普通发送 / reEditCall）——
  // recall 不写新 user message；resume 不写 DB
  let userMessageId: string | undefined;
  if (shouldPersistMessages && !isRecall) {
    try {
      const userParts = contentsToUserParts(contents, resolvedFiles);
      const r = await insertUserMessageRecord({
        sessionId: resolvedThreadId,
        parts: userParts,
        uploadedFiles: resolvedFiles.length > 0 ? resolvedFiles : undefined,
      });
      userMessageId = r.messageId;
    } catch (e) {
      console.error('[POST /api/v3/chat] insertUserMessageRecord failed:', e);
      return new Response(
        JSON.stringify({
          error: 'failed to save user message',
          message: (e as Error)?.message,
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  // 预生成 assistantMessageId（普通发送 / recall / reEditCall 都需要落库）
  const assistantMessageId = shouldPersistMessages ? uuidv4() : undefined;

  // —— 提交 run（fire-and-forget）——
  let run_id: string;
  try {
    const threadService = await getThreadService();
    const r = await threadService.submitRun({
      thread_id: resolvedThreadId,
      user_id,
      input: inputText,
    });
    run_id = r.run_id;
  } catch (e) {
    const code = (e as Error & { code?: string })?.code;
    const status = code === 'NOT_FOUND' ? 404 : 500;
    console.error('[POST /api/v3/chat] submitRun failed:', e);
    return new Response(
      JSON.stringify({
        error: 'failed to submit run',
        message: (e as Error)?.message,
      }),
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // —— 构造 START 事件 payload ——
  const startPayload: Record<string, unknown> = {
    run_id,
    thread_id: resolvedThreadId,
    sessionId: resolvedThreadId,
  };
  if (createdChatSession) startPayload.chatSession = createdChatSession;
  if (typeof userMessageId === 'string') startPayload.userMessageId = userMessageId;
  if (typeof assistantMessageId === 'string') startPayload.assistantMessageId = assistantMessageId;

  // —— 包一层「parts collector + 收尾持久化」 ——
  const wrapWithPersistence = async function* (
    inner: AsyncIterable<ClientAgentEvent>,
  ): AsyncGenerator<ClientAgentEvent> {
    yield createClientAgentEvent(ClientAgentEventType.START, 'lead', startPayload as never);

    const collector = shouldPersistMessages ? new AssistantPartsCollector() : null;
    try {
      for await (const ev of inner) {
        if (collector) collector.onEvent(ev);
        yield ev;
      }
    } finally {
      if (collector && typeof assistantMessageId === 'string') {
        const finalized: { parts: MessagePart[]; interrupt: ChatMessageType['interrupt'] } =
          collector.finalize(inputText);
        if (finalized.parts.length > 0) {
          try {
            await insertAssistantMessageRecord({
              sessionId: resolvedThreadId,
              messageId: assistantMessageId,
              parts: finalized.parts,
              interrupt: finalized.interrupt,
            });
          } catch (e) {
            console.error('[POST /api/v3/chat] insertAssistantMessageRecord failed:', e);
          }
        }
      }
    }
  };

  let merged: AsyncGenerator<ClientAgentEvent>;
  if (dynamicClient) {
    const eventStream = dynamicClient.stream(inputText, resolvedThreadId);
    merged = wrapWithPersistence(eventStream);
  } else {
    const service = await getThreadService();
    const subscription = service.subscribe({ thread_id: resolvedThreadId, run_id });
    merged = wrapWithPersistence(subscription);
  }

  const stream = createSseStream(request, merged);
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Run-Id': run_id,
      'X-Thread-Id': resolvedThreadId,
    },
  });
}

function pickEarlier(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}
