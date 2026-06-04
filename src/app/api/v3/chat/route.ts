/**
 * /api/v3/chat —— 单一聊天入口
 *
 * 协议（请求体）：
 *   POST application/json
 *   {
 *     "sessionId"?: string,                       // 缺省 = 新建会话；存在 = 已有会话
 *     "configuration"?: {
 *       "model"?: { "value"?: string },           // 替代旧的 metadata.modelKey
 *       "memoryEnabled"?: boolean                 // 单次请求覆盖服务级 memory 开关
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
 */

import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';

import {
  ClientAgentEventType,
  createClientAgentEvent,
  createSseStream,
  consumeTitleUpdate,
  type ClientAgentEvent,
} from '@/deerflow-harness';
import type { MessagePart, ChatMessageType } from '@/types';
import { getThreadService, resolveModelConfigFromConfiguration } from '../../threads/_service';
import { getCurrentUser } from '../../auth/_helpers';
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
import { AssistantPartsCollector } from '@/utils/chat/assistant-parts-collector';

// 协议类型

type TextBlock = { type: 'text'; text: string };
type FileBlock = { type: 'file'; fileId: string };
type ImageBlock = { type: 'image'; fileId: string };
type ContentBlock = TextBlock | FileBlock | ImageBlock;

interface ChatStreamBody {
  sessionId?: string;
  configuration?: {
    model?: { value?: string };
    /** 本次请求是否启用长期记忆；不传 = 走服务级默认（_service.ts 注入 true）。 */
    memoryEnabled?: boolean;
    [k: string]: unknown;
  } | null;
  message: { contents: ContentBlock[] };
  stream?: true;
  operation?: 'resume' | 'recall' | 'reEditCall';
}

// 工具

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

// 路由实现

function pickEarlier(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser(request);
  if (!currentUser) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const user_id = currentUser.id;

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
      createdChatSession = await createChatSessionRecord({ title, userId: user_id });
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

  // 单路径：始终走 submitRun（fire-and-forget）+ StreamBridge.subscribe。
  // 带模型配置时把 modelConfig 透传给 submitRun，由 service 解析对应 client，
  // 不再有 dynamicClient 直连分支（避免 Agent 被执行两次、断线无法回放）。
  const modelConfig = resolveModelConfigFromConfiguration(body.configuration ?? undefined);

  // 运行期开关：仅当 client 端显式传入 boolean 时才透传，None/undefined 留给
  // DeerFlowClient.resolveRuntimeOptions 走 baseOptions 默认值。
  const memoryEnabledOverride =
    typeof body.configuration?.memoryEnabled === 'boolean'
      ? body.configuration.memoryEnabled
      : undefined;
  const runMetadata: Record<string, unknown> | undefined =
    typeof memoryEnabledOverride === 'boolean'
      ? { memoryEnabled: memoryEnabledOverride }
      : undefined;

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
        userId: user_id,
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
    const r = isResume
      ? await threadService.resume({
          thread_id: resolvedThreadId,
          user_id,
          decision: inputText,
          ...(modelConfig ? { modelConfig } : {}),
          ...(runMetadata ? { metadata: runMetadata } : {}),
        })
      : await threadService.submitRun({
          thread_id: resolvedThreadId,
          user_id,
          input: inputText,
          ...(modelConfig ? { modelConfig } : {}),
          ...(runMetadata ? { metadata: runMetadata } : {}),
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
        if (ev.eventType === ClientAgentEventType.END) {
          // 过滤 StreamBridge 内部发出的 system END（仅用于唤醒挂起订阅者）
          if (ev.agentId === 'system') continue;
          const titleUpdate = consumeTitleUpdate(resolvedThreadId);
          if (titleUpdate) {
            yield createClientAgentEvent(ClientAgentEventType.END, ev.agentId, { titleUpdate });
            continue;
          }
        }
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
              userId: user_id,
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

  const service = await getThreadService();
  const subscription = service.subscribe({ thread_id: resolvedThreadId, run_id });
  const merged: AsyncGenerator<ClientAgentEvent> = wrapWithPersistence(subscription);

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
