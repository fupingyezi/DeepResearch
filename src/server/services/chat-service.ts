/**
 * 聊天编排服务（v3/chat 的三层化落点）。
 *
 * 职责分界：
 * - 纯函数（pickInputText / contentsToUserParts / cancelledMarkerText /
 *   resolveRunMetadata 等）：可单测的协议处理
 * - prepare：preflight 全序列（顺序即不变量，见方法注释），返回「精确错误形状」
 *   或 PreparedChat —— SSE 路由的前置失败是 JSON，错误体逐条保持历史形状
 * - submit：submitRun / resume（fire-and-forget）
 * - streamEvents：wrapWithPersistence 生成器 —— **必须整体传给
 *   createSseStream(request, events)**，abort 的 break 触发 generator.return()
 *   才执行 finally 落库
 */

import { v4 as uuidv4 } from 'uuid';

import {
  ClientAgentEventType,
  consumeTitleUpdate,
  createClientAgentEvent,
  type ClientAgentEvent,
  type ModelConfig,
  type ThreadImageRef,
  type ThreadService,
} from '@/deerflow-harness';
import type { ChatMessageType, MessagePart } from '@/types';
import { AssistantPartsCollector } from '@/utils/chat/assistant-parts-collector';
import { getThreadService } from '@/server/wiring';
import type { ChatSessionRecord } from '@/server/daos/chat-session';
import { ChatSessionAccessError } from '@/server/daos/chat-session';
import type { SavedFileMetadata } from '@/server/daos/file-metadata';
import { resolveUserModelConfig } from '@/server/services/model-config-service';
import {
  getConversationService,
  type ConversationService,
} from '@/server/services/conversation-service';
import type { ChatContentBlock, ChatStreamBody } from '@/server/validation/schemas';

// ---- 纯函数：协议处理 ----

/** 把 contents 中的 text block 按序拼接（多个 text block 各自独立 part，输入文本整体拼）。 */
export function pickInputText(contents: ChatContentBlock[]): string {
  const segments: string[] = [];
  for (const block of contents) {
    if (block && block.type === 'text' && typeof block.text === 'string') segments.push(block.text);
  }
  return segments.join('\n').trim();
}

/** 提取 contents 中全部 file/image 的 fileId（保持视觉顺序）。 */
export function pickFileIds(contents: ChatContentBlock[]): string[] {
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

/**
 * 把 message.contents 转换为 user message 的 parts[]：
 * - text  → text part（多个 text block 各自独立 part；前端历史展示按时序拼接）
 * - file  → file part（resolved file 元信息一并写入 content）
 * - image → image part
 */
export function contentsToUserParts(
  contents: ChatContentBlock[],
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
    } else {
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

/** 两个时刻中较早的一个（都不存在 → undefined）。 */
export function pickEarlier(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

/**
 * run 的 error 文本 → 「本轮被取消」标记文案；不是取消则返回 null。
 *
 * 文案与 harness 侧 ThreadService 写入的取消原因一一对应（runtime/service.ts 的
 * RUN_CANCELLED_* 常量）：用户点停止 / 被新消息抢占 / 对话被删（后者用户看不到，
 * 会话本身都没了）。前端停止时也会就地加同一条标记，两边文案保持一致。
 */
export function cancelledMarkerText(runError: string | null): string | null {
  // 用 includes 而非 startsWith：取消原因可能被 LangChain 的中间件链包一层前缀
  // （`Error in middleware "SubagentLimitMiddleware": cancelled: stopped by user`）
  if (!runError || !runError.includes('cancelled:')) return null;
  if (runError.includes('stopped by user')) return '用户已取消';
  if (runError.includes('superseded by a new run')) return '已被新消息取代';
  return '本轮已取消';
}

/**
 * 从请求 configuration 解析运行期开关。
 *
 * - memoryEnabled：仅当显式传入 boolean 才透传，undefined 留给
 *   DeerFlowClient.resolveRuntimeOptions 走 baseOptions 默认值
 * - memoryMode：仅接受 'retrieve' | 'inject' 两个字面量，拼写错误不改变默认行为
 */
export function resolveRunMetadata(
  configuration?: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const memoryEnabledOverride =
    typeof configuration?.memoryEnabled === 'boolean' ? configuration.memoryEnabled : undefined;
  const memoryModeOverride =
    configuration?.memoryMode === 'retrieve' || configuration?.memoryMode === 'inject'
      ? configuration.memoryMode
      : undefined;

  return typeof memoryEnabledOverride === 'boolean' || memoryModeOverride !== undefined
    ? {
        ...(typeof memoryEnabledOverride === 'boolean'
          ? { memoryEnabled: memoryEnabledOverride }
          : {}),
        ...(memoryModeOverride !== undefined ? { memoryMode: memoryModeOverride } : {}),
      }
    : undefined;
}

// ---- 编排类型 ----

export interface PrepareChatInput {
  userId: string;
  body: ChatStreamBody;
}

/** prepare 成功后 submit / streamEvents 共用的上下文。 */
export interface PreparedChat {
  userId: string;
  threadId: string;
  chatSession: ChatSessionRecord | null;
  inputText: string;
  images: ThreadImageRef[];
  modelConfig: ModelConfig;
  runMetadata: Record<string, unknown> | undefined;
  isResume: boolean;
  shouldPersistMessages: boolean;
  shouldUpdateOnResume: boolean;
  resumeSeedParts: MessagePart[];
  userMessageId: string | undefined;
  assistantMessageId: string | undefined;
}

/**
 * SSE 路由的前置失败形状：body 是精确的 JSON 载荷（历史错误体逐条保持），
 * 路由只负责 JSON.stringify + headers，不重新映射。
 */
export type ChatPrepareResult =
  | { ok: true; prepared: PreparedChat }
  | { ok: false; status: number; body: Record<string, unknown> };

export type ChatSubmitResult =
  | { ok: true; runId: string }
  | { ok: false; status: number; body: Record<string, unknown> };

export interface ChatServiceDeps {
  conversations: ConversationService;
  getThreadService: () => Promise<ThreadService>;
}

export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  /**
   * preflight 全序列。顺序即不变量，改动前逐条对照：
   *   auth（路由层）→ contents 校验（路由层 zod）→ inputText →
   *   resolveFilesByIds（失败 warn 继续）→ images →
   *   模型预检（**建会话之前**，400 防空会话）→ ensureSession（403）→
   *   createThread 幂等 → recall/reEdit 截断 → user message
   *   （recall 不写、resume 不写 DB）→ assistantMessageId 预生成
   *   （resume 走 getLatestAssistantWithParts 取 id+seed）
   */
  async prepare(input: PrepareChatInput): Promise<ChatPrepareResult> {
    const { userId, body } = input;

    const operation = body.operation;
    const isResume = operation === 'resume';
    const isRecall = operation === 'recall';
    const isReEdit = operation === 'reEditCall';
    const shouldPersistMessages = !isResume;

    const contents = body.message.contents;
    const inputText = pickInputText(contents);
    if (!inputText) {
      return {
        ok: false,
        status: 400,
        body: { error: 'message.contents must contain at least one text block' },
      };
    }

    const fileIds = pickFileIds(contents);
    let resolvedFiles: SavedFileMetadata[] = [];
    if (fileIds.length > 0) {
      try {
        resolvedFiles = await this.deps.conversations.resolveFilesByIds(fileIds);
      } catch (e) {
        console.error('[POST /api/v3/chat] resolveFilesByIds failed:', e, { fileIds });
      }
    }

    // 本轮随消息附带的图片（仅 image/*）：走 submitRun 显式参数而非 metadata
    // （metadata 会被 `...metadata` 展开进每个事件载荷，塞图片引用会污染前端协议）。
    // 是否真的以多模态下发由 client.stream 按 modelConfig.supportsVision 二次判定 ——
    // 此处不做视觉能力判断，避免第二个真相源。
    const images: ThreadImageRef[] = resolvedFiles
      .filter((f) => f.mimeType.startsWith('image/'))
      .map((f) => ({
        fileId: f.fileId,
        filename: f.filename,
        mimeType: f.mimeType,
        minioKey: f.minioKey,
        sizeBytes: f.sizeBytes,
      }));

    // —— 模型与 Key 解析（前置守卫，置于建会话之前以避免产生空会话） ——
    const modelResolution = await resolveUserModelConfig(userId, body.configuration ?? undefined);
    if (!modelResolution.ok) {
      const isNoKey = modelResolution.reason === 'NO_KEY';
      return {
        ok: false,
        status: 400,
        body: {
          error: isNoKey ? 'no_api_key' : 'no_model_selected',
          message: isNoKey
            ? `尚未为 ${modelResolution.provider} 配置 API Key，请前往「设置 - 模型管理」填写后再试。`
            : '尚未选择模型，请前往「设置 - 模型管理」选择模型并填写 API Key 后再试。',
          ...(isNoKey ? { provider: modelResolution.provider } : {}),
        },
      };
    }
    const modelConfig = modelResolution.modelConfig;

    // —— sessionId 分流 ——
    // 无论有没有传 sessionId，都先「确保会话行存在」：传进来的 id 未必真的落过库 ——
    // 前端首个请求失败（没收到 START）时不会重置本地状态，下一轮会把本地生成的临时 UUID
    // 当「已有会话」发过来。旧实现只在「没传 sessionId」时建行，于是这种情况会先建成
    // threads_meta 孤儿，紧接着 chat_message 插入撞 session_id 外键 500，run 永远起不来。
    const incomingSessionId =
      typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : null;

    let chatSession: ChatSessionRecord | null = null;
    try {
      const title = inputText.slice(0, 15) || 'New thread';
      chatSession = await this.deps.conversations.ensureSession({
        id: incomingSessionId ?? undefined,
        title,
        userId,
      });
    } catch (e) {
      if (e instanceof ChatSessionAccessError) {
        console.warn('[POST /api/v3/chat] session access denied:', (e as Error)?.message);
        return { ok: false, status: 403, body: { error: 'forbidden' } };
      }
      console.error('[POST /api/v3/chat] ensureChatSessionRecord failed:', e);
      return {
        ok: false,
        status: 500,
        body: { error: 'failed to create chat session', message: (e as Error)?.message },
      };
    }
    const threadId = chatSession.id;

    const runMetadata = resolveRunMetadata(body.configuration);

    // —— 幂等创建 thread ——
    try {
      const threadService = await this.deps.getThreadService();
      await threadService.createThread({
        thread_id: threadId,
        user_id: userId,
        display_name: inputText.slice(0, 15) || 'New thread',
      });
    } catch (e) {
      console.error('[POST /api/v3/chat] createThread failed:', e);
      return {
        ok: false,
        status: 500,
        body: { error: 'failed to create thread', message: (e as Error)?.message },
      };
    }

    // —— recall / reEditCall 截断 ——
    if (shouldPersistMessages && (isRecall || isReEdit)) {
      try {
        if (isRecall) {
          const lastAssistant = await this.deps.conversations.getLatestMessageByRole(
            threadId,
            'assistant',
          );
          if (lastAssistant) {
            await this.deps.conversations.deleteMessagesAtOrAfter(
              threadId,
              lastAssistant.createdAt,
            );
          }
        } else {
          // reEditCall：删除最近一对 user+assistant
          const lastAssistant = await this.deps.conversations.getLatestMessageByRole(
            threadId,
            'assistant',
          );
          const lastUser = await this.deps.conversations.getLatestMessageByRole(threadId, 'user');
          const cutoff = pickEarlier(lastAssistant?.createdAt, lastUser?.createdAt);
          if (cutoff) {
            await this.deps.conversations.deleteMessagesAtOrAfter(threadId, cutoff);
          }
        }
      } catch (e) {
        console.error('[POST /api/v3/chat] truncate before retry failed:', e);
        return {
          ok: false,
          status: 500,
          body: { error: 'failed to truncate previous messages', message: (e as Error)?.message },
        };
      }
    }

    // —— 写入 user message（普通发送 / reEditCall）——
    // recall 不写新 user message；resume 不写 DB
    let userMessageId: string | undefined;
    if (shouldPersistMessages && !isRecall) {
      try {
        const userParts = contentsToUserParts(contents, resolvedFiles);
        const r = await this.deps.conversations.saveUserMessage({
          sessionId: threadId,
          userId,
          parts: userParts,
          uploadedFiles: resolvedFiles.length > 0 ? resolvedFiles : undefined,
        });
        userMessageId = r.messageId;
      } catch (e) {
        console.error('[POST /api/v3/chat] insertUserMessageRecord failed:', e);
        return {
          ok: false,
          status: 500,
          body: { error: 'failed to save user message', message: (e as Error)?.message },
        };
      }
    }

    // 预生成 assistantMessageId。
    // - 普通发送 / recall / reEditCall：新建一条 assistant 消息（INSERT）。
    // - resume：复用中断时落库的同一条 assistant 消息（UPDATE 续写），
    //   并用其既有 parts 作为 collector 的 seed，使 ask_clarification 的
    //   TOOL_RESULT 能凭 toolCallId 命中、把 running 改为 done，最终答案追加其后。
    let assistantMessageId: string | undefined = shouldPersistMessages ? uuidv4() : undefined;
    let resumeSeedParts: MessagePart[] = [];
    if (isResume) {
      try {
        const existing = await this.deps.conversations.getLatestAssistantWithParts(
          threadId,
          userId,
        );
        if (existing) {
          assistantMessageId = existing.id;
          resumeSeedParts = existing.parts;
        }
      } catch (e) {
        console.error('[POST /api/v3/chat] load assistant message for resume failed:', e);
      }
    }
    // 续写落库（UPDATE）仅在成功定位到既有 assistant 消息时启用
    const shouldUpdateOnResume = isResume && typeof assistantMessageId === 'string';

    return {
      ok: true,
      prepared: {
        userId,
        threadId,
        chatSession,
        inputText,
        images,
        modelConfig,
        runMetadata,
        isResume,
        shouldPersistMessages,
        shouldUpdateOnResume,
        resumeSeedParts,
        userMessageId,
        assistantMessageId,
      },
    };
  }

  /** 提交 run（fire-and-forget），立即返回 run_id。 */
  async submit(prepared: PreparedChat): Promise<ChatSubmitResult> {
    try {
      const threadService = await this.deps.getThreadService();
      const r = prepared.isResume
        ? await threadService.resume({
            thread_id: prepared.threadId,
            user_id: prepared.userId,
            decision: prepared.inputText,
            ...(prepared.modelConfig ? { modelConfig: prepared.modelConfig } : {}),
            ...(prepared.runMetadata ? { metadata: prepared.runMetadata } : {}),
          })
        : await threadService.submitRun({
            thread_id: prepared.threadId,
            user_id: prepared.userId,
            input: prepared.inputText,
            ...(prepared.images.length ? { images: prepared.images } : {}),
            ...(prepared.modelConfig ? { modelConfig: prepared.modelConfig } : {}),
            ...(prepared.runMetadata ? { metadata: prepared.runMetadata } : {}),
          });
      return { ok: true, runId: r.run_id };
    } catch (e) {
      const code = (e as Error & { code?: string })?.code;
      const status = code === 'NOT_FOUND' ? 404 : 500;
      console.error('[POST /api/v3/chat] submitRun failed:', e);
      return {
        ok: false,
        status,
        body: { error: 'failed to submit run', message: (e as Error)?.message },
      };
    }
  }

  /**
   * START 帧 + parts collector + 收尾持久化的生成器。
   *
   * 必须把**整个生成器**传给 createSseStream(request, events)（路由层完成）：
   * abort 的 break 触发 generator.return() 才执行 finally 落库 ——
   * 改成「流结束后路由层 await 落库」会在 abort 路径丢持久化。
   */
  async *streamEvents(prepared: PreparedChat, runId: string): AsyncGenerator<ClientAgentEvent> {
    const startPayload: Record<string, unknown> = {
      run_id: runId,
      thread_id: prepared.threadId,
      sessionId: prepared.threadId,
    };
    // 总是回传会话记录：正常新建时前端要把它加进侧栏；「临时 id 首次落库」那种续聊也
    // 需要（此前这类对话因为没落库、永远不进侧栏）；真正的续聊则被 store 的 addChatSession
    // 按同 id 幂等跳过，重复下发无副作用。
    if (prepared.chatSession) startPayload.chatSession = prepared.chatSession;
    if (typeof prepared.userMessageId === 'string')
      startPayload.userMessageId = prepared.userMessageId;
    if (typeof prepared.assistantMessageId === 'string')
      startPayload.assistantMessageId = prepared.assistantMessageId;

    yield createClientAgentEvent(ClientAgentEventType.START, 'lead', startPayload as never);

    // resume 续写时用既有 parts seed，使续跑的 TOOL_RESULT 能命中中断前的 tool_call。
    const collector =
      prepared.shouldPersistMessages || prepared.shouldUpdateOnResume
        ? new AssistantPartsCollector(
            prepared.shouldUpdateOnResume ? prepared.resumeSeedParts : undefined,
          )
        : null;

    const threadService = await this.deps.getThreadService();
    const subscription = threadService.subscribe({
      thread_id: prepared.threadId,
      run_id: runId,
    });

    try {
      for await (const ev of subscription) {
        if (collector) collector.onEvent(ev);
        if (ev.eventType === ClientAgentEventType.END) {
          // 过滤 StreamBridge 内部发出的 system END（仅用于唤醒挂起订阅者）
          if (ev.agentId === 'system') continue;
          const titleUpdate = consumeTitleUpdate(prepared.threadId);
          if (titleUpdate) {
            yield createClientAgentEvent(ClientAgentEventType.END, ev.agentId, { titleUpdate });
            continue;
          }
        }
        yield ev;
      }
    } finally {
      if (collector && typeof prepared.assistantMessageId === 'string') {
        // 这轮是被取消的吗？落库的 parts 才是刷新后的真相源，取消标记必须服务端也写一份，
        // 否则「已产出内容 + 用户已取消」只在当前页面上存在，刷新就没了。
        // 客户端先断流再发 cancel，断流那一刻 run 往往还在 running，必须等终态（1s 上限）。
        const cancelledText = cancelledMarkerText(
          await this.deps.conversations.waitRunError(runId),
        );

        const finalized: { parts: MessagePart[]; interrupt: ChatMessageType['interrupt'] } =
          collector.finalize(prepared.inputText, cancelledText);
        if (finalized.parts.length > 0) {
          try {
            if (prepared.shouldUpdateOnResume) {
              // resume：覆盖式回写到中断时那条 assistant 消息
              await this.deps.conversations.updateAssistantParts(
                prepared.assistantMessageId,
                finalized.parts,
              );
            } else {
              await this.deps.conversations.saveAssistantMessage({
                sessionId: prepared.threadId,
                userId: prepared.userId,
                messageId: prepared.assistantMessageId,
                parts: finalized.parts,
                interrupt: finalized.interrupt,
              });
            }
          } catch (e) {
            console.error('[POST /api/v3/chat] persist assistant message failed:', e);
          }
        }
      }
    }
  }
}

export function createChatService(deps?: Partial<ChatServiceDeps>): ChatService {
  return new ChatService({
    conversations: deps?.conversations ?? getConversationService(),
    getThreadService: deps?.getThreadService ?? getThreadService,
  });
}

// 模块级懒单例即可：本服务无状态（与 conversation-service 同一约定）。
let service: ChatService | null = null;

export function getChatService(): ChatService {
  if (!service) service = createChatService();
  return service;
}
