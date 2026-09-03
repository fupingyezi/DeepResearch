import { ChatMessageType, ChatSessionType, ChatUploadedFileRef, MessagePart } from '@/types';
import type { ModelPresetName } from '@/config/models';
import { UUIDTypes, v4 as uuidv4 } from 'uuid';

import { createAgentEventStream, ClientAgentEventType } from '@/runtime';
import {
  appendStandaloneText,
  createPartsStateFromExisting,
  finalizePartsState,
  initialPartsState,
  reducePartsState,
  type PartsState,
} from './parts-reducer';
import { createRafFlusher, type RafFlusher } from '@/utils/common';
import { TitleUpdatePayload } from '@/deerflow-harness';
import type { SessionRunStatus } from '@/store/chat-session-store';

export interface StreamChatConfig {
  operation?: 'resume' | 'recall' | 'reEditCall';
  inputValue: string;
  /** operation === 'resume' 时使用：'确认'/'拒绝'等 human-in-the-loop 决策文本 */
  resumeDecision?: string;
  sessionId?: UUIDTypes;
  /**
   * 是否新建对话：为 true 时 sessionId 仅作为「前端临时桶 key / 当前视图 id」，
   * 请求体不携带 sessionId（由后端新建并在 START 回传真实 id，再迁移桶）。
   */
  isNewSession?: boolean;
  /** 已上传文件的元信息（前端上传后拿到，转成 message.contents 中的 file/image block，仅传 fileId） */
  uploadedFiles?: ChatUploadedFileRef[];
  chatSessions: ChatSessionType[];
  currentMessages: ChatMessageType[];

  setShouldAutoScroll: (scroll: boolean) => void;
  addChatSession: (session: ChatSessionType) => void;
  updateChatSession: (session: ChatSessionType, op: 'edit' | 'delete') => void;

  /**
   * 多对话并行：以下全部按 sessionId 分桶写回，绝不触碰「当前查看对话」以外的状态。
   * 当写回的 sessionId 恰为当前对话时，store 内部会自动投影到 current*（视图无感）。
   */
  setSessionMessages: (sessionId: string, messages: ChatMessageType[]) => void;
  setSessionStatus: (sessionId: string, status: SessionRunStatus) => void;
  setSessionAbortController: (sessionId: string, controller: AbortController | null) => void;
  /** 新建对话 START 后，把前端临时 sessionId 桶迁移到后端真实 sessionId 桶。 */
  migrateSessionRuntime: (fromSessionId: string, toSessionId: string) => void;

  /** 模型预设标识（映射成 configuration.model.value 等运行配置） */
  model?: ModelPresetName;

  onStreamComplete?: (data: Record<string, unknown>) => void;
  onStreamError?: (error: unknown) => void;
}

/**
 * StreamChatHandler
 *
 * 前端 SSE 消费者。聚合规则由 `parts-reducer` 这一份纯函数实现（与后端共享），
 * 本类只负责前端独有的职责：
 *  - session / message 占位与 START 事件后的 id rewrite
 *  - rAF 合帧 commit 到 React store
 *  - 错误兜底文本
 *  - END 时调用 reducer finalize 进行 task_summary / artifact 标记抽取
 */
export class StreamChatHandler {
  private config: StreamChatConfig;
  private abortController: AbortController | null = null;
  private sessionId: UUIDTypes = '';
  private isNewSession = false;
  private assistantMessageId: string = '';
  private initialUpdateMessages: ChatMessageType[] = [];

  /** 本次 run 的终态：正常结束 done / 出错 error / 被用户中止 idle。cleanup 据此落桶。 */
  private finalStatus: SessionRunStatus = 'done';

  /** 流式期间维护的不可变聚合状态 */
  private state: PartsState = initialPartsState;

  /** rAF 合帧调度器（class 与 hook 不互通，使用纯工厂函数） */
  private flusher: RafFlusher;

  constructor(config: StreamChatConfig) {
    this.config = config;
    this.flusher = createRafFlusher(() => this.commitFlush());
  }

  async execute(): Promise<void> {
    if (this.config.inputValue === '' && this.config.operation !== 'resume') return;

    this.handleSession();
    this.setupAbortController();

    if (this.config.operation === undefined) {
      this.initializeMessages();
    } else if (this.config.operation === 'resume') {
      this.resumeMessages();
    } else {
      this.reInitializeMessages();
    }

    await this.executeStreamRequest();
  }

  // session / messages 初始化
  private handleSession(): void {
    // 新建对话：sessionId 是外部预生成的临时桶 key，请求体不带 sessionId（后端新建）。
    if (this.config.isNewSession) {
      this.sessionId = this.config.sessionId || uuidv4();
      this.isNewSession = true;
      return;
    }

    const existing = this.config.sessionId || '';
    if (existing) {
      this.sessionId = existing;
      this.isNewSession = false;
      return;
    }

    this.sessionId = uuidv4();
    this.isNewSession = true;
  }

  private setupAbortController(): void {
    this.abortController = new AbortController();
    const sid = String(this.sessionId);
    this.config.setSessionAbortController(sid, this.abortController);
    this.config.setSessionStatus(sid, 'running');
  }

  private initializeMessages(): void {
    const userMessage: ChatMessageType = {
      id: uuidv4(),
      sessionId: this.sessionId,
      role: 'user',
      parts: [
        {
          partId: uuidv4(),
          type: 'text',
          createdAt: Date.now(),
          content: { text: this.config.inputValue },
        },
      ],
      createdAt: Date.now(),
    };

    this.assistantMessageId = uuidv4();
    this.state = initialPartsState;

    const assistantMessage: ChatMessageType = {
      id: this.assistantMessageId,
      sessionId: this.sessionId,
      role: 'assistant',
      parts: [],
      createdAt: Date.now(),
    };

    this.initialUpdateMessages = [...this.config.currentMessages, userMessage, assistantMessage];

    this.config.setSessionMessages(String(this.sessionId), this.initialUpdateMessages);
    this.config.setShouldAutoScroll(true);
  }

  private reInitializeMessages(): void {
    const len = this.config.currentMessages.length;
    this.state = initialPartsState;

    if (this.config.operation === 'recall') {
      const lastAssistant = this.config.currentMessages[len - 1];
      this.assistantMessageId = String(lastAssistant?.id ?? uuidv4());
      this.initialUpdateMessages = [
        ...this.config.currentMessages.slice(0, len - 1),
        {
          ...lastAssistant,
          id: this.assistantMessageId,
          parts: [],
          interrupt: null,
        },
      ];
    } else {
      // reEditCall：覆盖最近的 user message + 重置最后一条 assistant
      const lastAssistant = this.config.currentMessages[len - 1];
      const lastUser = this.config.currentMessages[len - 2];
      this.assistantMessageId = String(lastAssistant?.id ?? uuidv4());
      const replacedUser: ChatMessageType = {
        ...lastUser,
        parts: [
          {
            partId: uuidv4(),
            type: 'text',
            createdAt: Date.now(),
            content: { text: this.config.inputValue },
          },
        ],
      };
      this.initialUpdateMessages = [
        ...this.config.currentMessages.slice(0, len - 2),
        replacedUser,
        {
          ...lastAssistant,
          id: this.assistantMessageId,
          parts: [],
          interrupt: null,
        },
      ];
    }

    this.config.setSessionMessages(String(this.sessionId), this.initialUpdateMessages);
    this.config.setShouldAutoScroll(true);
  }

  /**
   * resume 场景：用上一轮 assistant parts 构造 PartsState 继续累积。
   * 顶层 interrupt 被清空（resume 表示用户已应答中断）。
   */
  private resumeMessages(): void {
    const len = this.config.currentMessages.length;
    const last = this.config.currentMessages[len - 1];
    if (last?.role === 'assistant' && Array.isArray(last.parts)) {
      this.state = createPartsStateFromExisting(last.parts);
      this.assistantMessageId = String(last.id);
    } else {
      this.state = initialPartsState;
      this.assistantMessageId = String(last?.id ?? uuidv4());
    }
    this.initialUpdateMessages = this.config.currentMessages.map((message, idx) =>
      idx === len - 1 && message.role === 'assistant'
        ? { ...message, parts: [...this.state.parts], interrupt: null }
        : message,
    );
  }

  // SSE 处理
  private async executeStreamRequest(): Promise<void> {
    try {
      const isResumeOp = this.config.operation === 'resume';
      const inputText = isResumeOp
        ? (this.config.resumeDecision ?? this.config.inputValue ?? '')
        : this.config.inputValue;

      const contents: Array<
        | { type: 'text'; text: string }
        | { type: 'file'; fileId: string }
        | { type: 'image'; fileId: string }
      > = [{ type: 'text', text: inputText }];

      if (this.config.operation === undefined && Array.isArray(this.config.uploadedFiles)) {
        for (const file of this.config.uploadedFiles) {
          if (!file || typeof file.fileId !== 'string' || file.fileId.length === 0) continue;
          const mimeType = typeof file.mimeType === 'string' ? file.mimeType : '';
          const isImage = mimeType.startsWith('image/');
          contents.push({ type: isImage ? 'image' : 'file', fileId: file.fileId });
        }
      }

      const requestBody: Record<string, unknown> = {
        message: { contents },
        stream: true,
      };

      if (!this.isNewSession && this.sessionId) {
        requestBody.sessionId = this.sessionId;
      }

      if (typeof this.config.model === 'string' && this.config.model.length > 0) {
        requestBody.configuration = { model: { value: this.config.model } };
      }

      if (this.config.operation !== undefined) {
        requestBody.operation = this.config.operation;
      }

      await this.processSseStream('/api/v3/chat', requestBody);
    } catch (error) {
      await this.handleError(error);
    } finally {
      await this.cleanup();
    }
  }

  private async processSseStream(streamUrl: string, body: Record<string, unknown>): Promise<void> {
    const stream = createAgentEventStream({
      endpoint: streamUrl,
      method: 'POST',
      body,
      signal: this.abortController!.signal,
    });

    for await (const event of stream) {
      if (event.eventType === ClientAgentEventType.START) {
        // START 事件由前端处理：替换占位 sessionId / messageId / 注入 chatSession
        this.applyStartEvent(event.payload);
        continue;
      }

      if (event.eventType === ClientAgentEventType.ERROR) {
        console.error('[StreamChatHandler] stream error:', event.payload.errorMessage);
        throw Object.assign(new Error(event.payload.errorMessage), {
          name: event.payload.errorCode,
        });
      }

      if (event.eventType === ClientAgentEventType.END) {
        // 后端可能在 END 上挂 titleUpdate（autoTitle 异步落库后的最终标题）。
        // 在 finalize parts 之前先应用，避免 sider 列表展示落后一帧。
        this.applyEndTitleUpdate(event.payload);
        const finalized = finalizePartsState(this.state, this.config.inputValue ?? '');
        this.state = {
          ...this.state,
          parts: finalized.parts,
          lastPartType:
            finalized.parts[finalized.parts.length - 1]?.type ?? this.state.lastPartType,
          interrupt: finalized.interrupt,
        };
        this.flushMessageSync();
        return;
      }

      // HEARTBEAT 不入 parts、也无需触发重渲染
      if (event.eventType === ClientAgentEventType.HEARTBEAT) continue;

      // 其余事件统一交给 reducer 推进
      const next = reducePartsState(this.state, event);
      if (next !== this.state) {
        this.state = next;
        this.flushMessage();
      }
    }
  }

  /**
   * 处理 START 事件：把临时 sessionId / 占位 messageId 替换为后端下发的真实 uuid，
   * 并在新会话时把 chatSession 注入侧边栏列表。
   */
  private applyStartEvent(payload: {
    sessionId?: string;
    chatSession?: ChatSessionType;
    userMessageId?: string;
    assistantMessageId?: string;
  }): void {
    const {
      sessionId: realSessionId,
      userMessageId: realUserId,
      assistantMessageId: realAssistantId,
      chatSession,
    } = payload;
    const tempSessionId = this.sessionId;
    const tempAssistantId = this.assistantMessageId;

    if (realSessionId && realSessionId !== tempSessionId) {
      // 新建对话：把临时 id 桶迁移到后端真实 id 桶。migrate 内部仅当用户当前仍在看
      // 这个临时对话时才把 currentSessionId 切到真实 id——若用户已切走，则不打扰，
      // 从根源修复「对话跑完/START 后自动跳回」的串扰。
      this.config.migrateSessionRuntime(String(tempSessionId), realSessionId);
      this.sessionId = realSessionId;
    }
    if (realAssistantId) {
      this.assistantMessageId = realAssistantId;
    }

    this.rewriteMessageIds({
      tempSessionId,
      realSessionId,
      realUserId,
      tempAssistantId,
      realAssistantId,
    });
    this.addChatSession(chatSession);
  }

  /**
   * 单次扫描 initialUpdateMessages：
   * - 把临时 sessionId 替换为真实 sessionId
   * - 把"最后一条 user"的临时 id 替换为 realUserId
   * - 把匹配 tempAssistantId 的 assistant 消息 id 替换为 realAssistantId
   */
  private rewriteMessageIds(params: {
    tempSessionId: UUIDTypes;
    realSessionId?: string;
    realUserId?: string;
    tempAssistantId: string;
    realAssistantId?: string;
  }): void {
    const { tempSessionId, realSessionId, realUserId, tempAssistantId, realAssistantId } = params;
    if (!realSessionId && !realUserId && !realAssistantId) return;

    let lastUserIdx = -1;
    if (realUserId) {
      for (let i = this.initialUpdateMessages.length - 1; i >= 0; i--) {
        if (this.initialUpdateMessages[i].role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
    }

    let mutated = false;
    const updated = this.initialUpdateMessages.map((message, idx) => {
      const patch: Partial<ChatMessageType> = {};
      if (realSessionId && message.sessionId === tempSessionId) patch.sessionId = realSessionId;
      if (realUserId && idx === lastUserIdx) patch.id = realUserId;
      if (realAssistantId && message.role === 'assistant' && message.id === tempAssistantId)
        patch.id = realAssistantId;
      if (Object.keys(patch).length === 0) return message;
      mutated = true;
      return { ...message, ...patch };
    });

    if (mutated) {
      this.initialUpdateMessages = updated;
      this.config.setSessionMessages(String(this.sessionId), updated);
    }
  }

  private addChatSession(chatSession: ChatSessionType | undefined): void {
    if (!chatSession || typeof chatSession.id !== 'string') return;
    this.config.addChatSession({
      id: chatSession.id,
      seq_id: chatSession.seq_id ?? this.config.chatSessions.length + 1,
      title: chatSession.title || this.config.inputValue.slice(0, 15) || 'New thread',
      created_at: chatSession.created_at ?? Date.now(),
      updated_at: chatSession.updated_at ?? Date.now(),
    });
  }

  /**
   * 处理 END 事件挂载的 titleUpdate（autoTitle 异步落库结果）。
   *
   * 命中已有 session：调 updateChatSession('edit') 直接替换标题
   */
  private applyEndTitleUpdate(payload: { titleUpdate?: TitleUpdatePayload }): void {
    if (!payload || typeof payload !== 'object') return;
    const titleUpdate = payload.titleUpdate;
    if (!titleUpdate || typeof titleUpdate !== 'object') return;
    const { sessionId, title, updatedAt } = titleUpdate;
    if (typeof sessionId !== 'string' || typeof title !== 'string') return;
    const existing = this.config.chatSessions.find((s) => s.id === sessionId);
    const tsNumber = typeof updatedAt === 'number' ? updatedAt : Date.now();
    if (existing) {
      this.config.updateChatSession(
        {
          ...existing,
          title,
          updated_at: tsNumber,
        },
        'edit',
      );
    }
  }

  // flush（rAF 合帧）
  private flushMessage(): void {
    this.flusher.schedule();
  }

  private flushMessageSync(): void {
    this.flusher.flushSync();
  }

  /**
   * 把当前 state.parts 写回 store。
   *
   * 由于 reducer 是不可变更新（结构共享），未变更的 part 引用保持稳定，
   * 直接 spread 一层即可让 React 检测到 message 引用变化并重渲染。
   */
  private commitFlush(): void {
    const target = this.assistantMessageId;
    const partsSnapshot: MessagePart[] = [...this.state.parts];
    const interruptSnapshot = this.state.interrupt;
    let mutated = false;
    const updateMessages = this.initialUpdateMessages.map((message) => {
      if (message.id !== target) return message;
      mutated = true;
      return {
        ...message,
        parts: partsSnapshot,
        interrupt: interruptSnapshot,
      };
    });
    if (!mutated) return;
    this.initialUpdateMessages = updateMessages;
    this.config.setSessionMessages(String(this.sessionId), updateMessages);
  }

  // error / cleanup
  private async handleError(error: unknown): Promise<void> {
    const err = error as { name?: string; message?: string };
    if (err?.name === 'AbortError' || err?.name === 'AGENT_STREAM_ABORTED') {
      console.log('Chat was Interrupted by user');
      this.finalStatus = 'idle';
      if (this.config.onStreamComplete) {
        this.config.onStreamComplete({
          sessionId: this.sessionId,
          messageId: this.assistantMessageId,
        });
      }
    } else {
      console.error('Stream error:', error);
      this.finalStatus = 'error';

      if (this.config.onStreamError) {
        this.config.onStreamError(error);
      } else {
        this.state = appendStandaloneText(this.state, '出错了，哎嘿。');
        this.flushMessageSync();
      }
    }
  }

  private async cleanup(): Promise<void> {
    const sid = String(this.sessionId);
    this.config.setSessionStatus(sid, this.finalStatus);
    this.config.setSessionAbortController(sid, null);

    if (this.config.onStreamComplete) {
      this.config.onStreamComplete({
        sessionId: this.sessionId,
        messageId: this.assistantMessageId,
      });
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
