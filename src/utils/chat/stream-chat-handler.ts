import {
  ChatMessageType,
  ChatSessionType,
  MessagePart,
  SubagentToolCall,
  SubagentStructuredReport,
} from '@/types';
import { UUIDTypes, v4 as uuidv4 } from 'uuid';

import { createAgentEventStream, ClientAgentEventType } from '@/runtime';

export interface StreamChatConfig {
  /**
   * 操作类型：
   * - 缺省 = 普通发送（原 'direct'）
   * - 'resume'     = 中断恢复
   * - 'recall'     = 重新生成
   * - 'reEditCall' = 重新编辑
   */
  operation?: 'resume' | 'recall' | 'reEditCall';
  inputValue: string;
  /** operation === 'resume' 时使用：'确认'/'拒绝'等 human-in-the-loop 决策文本 */
  resumeDecision?: string;
  sessionId?: UUIDTypes;
  /** 已上传文件的元信息（前端上传后拿到，转成 message.contents 中的 file/image block，仅传 fileId） */
  uploadedFiles?: Array<{ fileId: string; mimeType?: string; [k: string]: unknown }>;
  chatSessions: ChatSessionType[];
  currentMessages: ChatMessageType[];

  // 全局 store 注入
  setIsChating: (loading: boolean) => void;
  setShouldAutoScroll: (scroll: boolean) => void;
  addChatSession: (session: ChatSessionType) => void;
  setCurrentSessionId: (id: UUIDTypes) => void;
  setCurrentMessages: (messages: ChatMessageType[]) => void;
  setAbortController: (controller: AbortController | null) => void;

  /** 模型/参数等运行配置（映射成 configuration.model.value 等） */
  modelKey?: string;

  // 自定义 hook
  onStreamComplete?: (data: Record<string, unknown>) => void;
  onStreamError?: (error: unknown) => void;
}

type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;
type SubagentTaskPart = Extract<MessagePart, { type: 'subagent_task' }>;
type ArtifactPart = Extract<MessagePart, { type: 'artifact' }>;

/**
 * StreamChatHandler
 *
 * 把 SSE 事件实时聚合为消息的 parts[]，并通过 rAF 合帧把最新 parts 写回
 * conversation-store。所有持久化由后端 /api/v3/chat 在 END 时统一完成，前端不
 * 再发起 update_messages / add_messages 等任何 DB 写请求。
 *
 * 合并规则与后端 AssistantPartsCollector 等价：
 *  - 连续 STREAM_CHUNK.text → 合并到一个 text part；
 *  - 连续 STREAM_CHUNK.reasoning → 合并到一个 reasoning part；
 *  - 被其它类型 part 打断后再次出现 text/reasoning 必须新建 part；
 *  - TOOL_RESULT 通过 toolCallId 反查写回对应 tool_call.content；
 *  - TASK_PROGRESS upsert 到 subagent_task part（其内部 children 维护子工具调用）；
 *  - STATE_UPDATE.report 追加 artifact part；
 *  - HUMAN_INTERRUPT 写顶层 message.interrupt（不入 parts）。
 */
export class StreamChatHandler {
  private config: StreamChatConfig;
  private abortController: AbortController | null = null;
  private sessionId: UUIDTypes = '';
  private isNewSession = false;
  private assistantMessageId: string = '';
  private initialUpdateMessages: ChatMessageType[] = [];

  /** 流式期间维护在内存里的 parts；每次更新都同步到对应消息 */
  private parts: MessagePart[] = [];
  private lastPartType: MessagePart['type'] | null = null;
  private partIndexByToolCallId = new Map<string, number>();
  private partIndexByTaskId = new Map<string, number>();
  private interrupt: ChatMessageType['interrupt'] = null;

  constructor(config: StreamChatConfig) {
    this.config = config;
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

  // ──────────────────────────────────────────────────────
  // session / messages 初始化
  // ──────────────────────────────────────────────────────

  private handleSession(): void {
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
    this.config.setAbortController(this.abortController);
    this.config.setIsChating(true);
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
    this.parts = [];
    this.lastPartType = null;
    this.partIndexByToolCallId.clear();
    this.partIndexByTaskId.clear();
    this.interrupt = null;

    const assistantMessage: ChatMessageType = {
      id: this.assistantMessageId,
      sessionId: this.sessionId,
      role: 'assistant',
      parts: [],
      createdAt: Date.now(),
    };

    this.initialUpdateMessages = [...this.config.currentMessages, userMessage, assistantMessage];

    this.config.setCurrentMessages(this.initialUpdateMessages);
    this.config.setShouldAutoScroll(true);
  }

  private reInitializeMessages(): void {
    const len = this.config.currentMessages.length;
    this.parts = [];
    this.lastPartType = null;
    this.partIndexByToolCallId.clear();
    this.partIndexByTaskId.clear();
    this.interrupt = null;

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

    this.config.setCurrentMessages(this.initialUpdateMessages);
    this.config.setShouldAutoScroll(true);
  }

  /**
   * resume 场景：继承上一轮的 parts（去掉 interrupt 标记），继续累积新增事件。
   *
   * 同时重建 partIndexByToolCallId / partIndexByTaskId 索引，确保后续 TOOL_RESULT
   * 与 TASK_PROGRESS upsert 能命中已有 part。
   */
  private resumeMessages(): void {
    const len = this.config.currentMessages.length;
    const last = this.config.currentMessages[len - 1];
    if (last?.role === 'assistant' && Array.isArray(last.parts)) {
      this.parts = last.parts.map((p) => clonePart(p));
      this.lastPartType = this.parts[this.parts.length - 1]?.type ?? null;
      this.rebuildIndexes();
      this.assistantMessageId = String(last.id);
      this.interrupt = null;
    } else {
      this.parts = [];
      this.lastPartType = null;
      this.partIndexByToolCallId.clear();
      this.partIndexByTaskId.clear();
      this.interrupt = null;
      this.assistantMessageId = String(last?.id ?? uuidv4());
    }
    this.initialUpdateMessages = this.config.currentMessages.map((msg, idx) =>
      idx === len - 1 && msg.role === 'assistant'
        ? { ...msg, parts: this.parts.map((p) => clonePart(p)), interrupt: null }
        : msg,
    );
  }

  private rebuildIndexes(): void {
    this.partIndexByToolCallId.clear();
    this.partIndexByTaskId.clear();
    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      if (part.type === 'tool_call') {
        this.partIndexByToolCallId.set(part.content.toolCallId, i);
      } else if (part.type === 'subagent_task') {
        this.partIndexByTaskId.set(part.content.taskId, i);
      }
    }
  }

  // ──────────────────────────────────────────────────────
  // SSE 处理
  // ──────────────────────────────────────────────────────

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

      if (typeof this.config.modelKey === 'string' && this.config.modelKey.length > 0) {
        requestBody.configuration = { model: { value: this.config.modelKey } };
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
      switch (event.eventType) {
        case ClientAgentEventType.STREAM_CHUNK: {
          const { text, reasoning } = event.payload;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            this.appendOrMergeReasoningPart(reasoning);
          }
          if (typeof text === 'string' && text.length > 0) {
            this.appendOrMergeTextPart(text);
          }
          this.flushMessage();
          break;
        }

        case ClientAgentEventType.TOOL_CALL: {
          this.pushToolCallPart(event.payload);
          this.flushMessage();
          break;
        }

        case ClientAgentEventType.TOOL_RESULT: {
          this.attachToolResult(event.payload);
          this.flushMessage();
          break;
        }

        case ClientAgentEventType.STATE_UPDATE: {
          this.applyStateUpdate(event.payload.stateType, event.payload.data);
          this.flushMessage();
          break;
        }

        case ClientAgentEventType.TASK_PROGRESS: {
          this.upsertSubagentTaskPart(event.payload);
          this.flushMessage();
          break;
        }

        case ClientAgentEventType.HUMAN_INTERRUPT: {
          this.interrupt = {
            question: event.payload.question,
            details: event.payload.details,
          };
          this.flushMessage();
          break;
        }

        case ClientAgentEventType.ERROR: {
          console.error('[StreamChatHandler] stream error:', event.payload.errorMessage);
          throw Object.assign(new Error(event.payload.errorMessage), {
            name: event.payload.errorCode,
          });
        }

        case ClientAgentEventType.START: {
          this.applyStartEvent(event.payload);
          break;
        }
        case ClientAgentEventType.HEARTBEAT:
          break;

        case ClientAgentEventType.END: {
          this.maybeExtractArtifactFromText();
          this.flushMessageSync();
          return;
        }

        default: {
          const _never: never = event;
          void _never;
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────
  // START 事件处理（sessionId / messageId 替换）
  // ──────────────────────────────────────────────────────

  /**
   * 处理 START 事件：把临时 sessionId / 占位 messageId 替换为后端下发的真实 uuid。
   *
   * - sessionId：仅当与当前不同才替换
   * - userMessageId：替换 currentMessages 中倒数第二条 user 消息的 id
   * - assistantMessageId：替换最后一条 assistant 消息（流式占位）的 id，并同步
   *   `this.assistantMessageId`，确保后续 commitFlush 能命中
   */
  private applyStartEvent(payload: {
    sessionId?: string;
    chatSession?: ChatSessionType;
    userMessageId?: string;
    assistantMessageId?: string;
  }): void {
    const realId = payload?.sessionId;
    const tempId = this.sessionId;
    const sessionChanged = !!realId && realId !== tempId;

    if (sessionChanged && realId) {
      this.sessionId = realId;
      this.config.setCurrentSessionId(realId);
    }

    const realUserId =
      typeof payload?.userMessageId === 'string' ? payload.userMessageId : undefined;
    const realAssistantId =
      typeof payload?.assistantMessageId === 'string' ? payload.assistantMessageId : undefined;

    const tempAssistantId = this.assistantMessageId;
    let tempUserId: string | undefined;
    for (let i = this.initialUpdateMessages.length - 1; i >= 0; i--) {
      const msg = this.initialUpdateMessages[i];
      if (msg.role === 'user') {
        tempUserId = String(msg.id);
        break;
      }
    }

    if (typeof realAssistantId === 'string') {
      this.assistantMessageId = realAssistantId;
    }

    let mutated = false;
    const updated = this.initialUpdateMessages.map((msg) => {
      let next = msg;
      if (sessionChanged && msg.sessionId === tempId) {
        next = { ...next, sessionId: realId! };
        mutated = true;
      }
      if (typeof realUserId === 'string' && msg.role === 'user' && msg.id === tempUserId) {
        next = { ...next, id: realUserId };
        mutated = true;
      }
      if (
        typeof realAssistantId === 'string' &&
        msg.role === 'assistant' &&
        msg.id === tempAssistantId
      ) {
        next = { ...next, id: realAssistantId };
        mutated = true;
      }
      return next;
    });
    if (mutated) {
      this.initialUpdateMessages = updated;
      this.config.setCurrentMessages(updated);
    }

    const cs = payload?.chatSession;
    if (cs && typeof cs === 'object' && typeof cs.id === 'string') {
      this.config.addChatSession({
        id: cs.id,
        seq_id: typeof cs.seq_id === 'number' ? cs.seq_id : this.config.chatSessions.length + 1,
        title:
          typeof cs.title === 'string' && cs.title.length > 0
            ? cs.title
            : this.config.inputValue.slice(0, 15) || 'New thread',
        created_at: typeof cs.created_at === 'number' ? cs.created_at : Date.now(),
        updated_at: typeof cs.updated_at === 'number' ? cs.updated_at : Date.now(),
      });
    }
  }

  // ──────────────────────────────────────────────────────
  // parts 维护
  // ──────────────────────────────────────────────────────

  private appendOrMergeTextPart(text: string): void {
    if (this.lastPartType === 'text') {
      const last = this.parts[this.parts.length - 1] as Extract<MessagePart, { type: 'text' }>;
      this.parts = [
        ...this.parts.slice(0, -1),
        { ...last, content: { text: last.content.text + text } },
      ];
      return;
    }
    this.parts = [
      ...this.parts,
      {
        partId: uuidv4(),
        type: 'text',
        createdAt: Date.now(),
        content: { text },
      },
    ];
    this.lastPartType = 'text';
  }

  private appendOrMergeReasoningPart(text: string): void {
    if (this.lastPartType === 'reasoning') {
      const last = this.parts[this.parts.length - 1] as Extract<MessagePart, { type: 'reasoning' }>;
      this.parts = [
        ...this.parts.slice(0, -1),
        { ...last, content: { text: last.content.text + text } },
      ];
      return;
    }
    this.parts = [
      ...this.parts,
      {
        partId: uuidv4(),
        type: 'reasoning',
        createdAt: Date.now(),
        content: { text },
      },
    ];
    this.lastPartType = 'reasoning';
  }

  private pushToolCallPart(payload: {
    toolCallId: string;
    toolName: string;
    arguments?: string;
  }): void {
    const args = parseJsonSafe(payload.arguments);
    const part: ToolCallPart = {
      partId: uuidv4(),
      type: 'tool_call',
      createdAt: Date.now(),
      content: {
        toolCallId: payload.toolCallId,
        name: payload.toolName,
        args,
        status: 'running',
      },
    };
    this.parts = [...this.parts, part];
    this.partIndexByToolCallId.set(payload.toolCallId, this.parts.length - 1);
    this.lastPartType = 'tool_call';
  }

  private attachToolResult(payload: {
    toolCallId: string;
    result: unknown;
    success: boolean;
    errorMessage?: string;
  }): void {
    const idx = this.partIndexByToolCallId.get(payload.toolCallId);
    if (typeof idx === 'number') {
      const target = this.parts[idx];
      if (target && target.type === 'tool_call') {
        const updated: ToolCallPart = {
          ...target,
          content: {
            ...target.content,
            result: payload.result,
            success: payload.success,
            errorMessage: payload.errorMessage,
            status: payload.success === false ? 'failed' : 'done',
          },
        };
        this.parts = [...this.parts.slice(0, idx), updated, ...this.parts.slice(idx + 1)];
        return;
      }
    }
    // 时序错乱兜底
    this.parts = [
      ...this.parts,
      {
        partId: uuidv4(),
        type: 'tool_result',
        createdAt: Date.now(),
        content: {
          toolCallId: payload.toolCallId,
          result: payload.result,
          success: payload.success,
          errorMessage: payload.errorMessage,
        },
      },
    ];
    this.lastPartType = 'tool_result';
  }

  private upsertSubagentTaskPart(payload: Record<string, unknown>): void {
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : '';
    const incomingStatus = typeof payload.status === 'string' ? payload.status : 'running';

    if (incomingStatus === 'tool_call' || incomingStatus === 'tool_result') {
      this.applySubagentToolEvent(taskId, payload, incomingStatus);
      return;
    }

    const idx = this.partIndexByTaskId.get(taskId);
    const prev = typeof idx === 'number' ? (this.parts[idx] as SubagentTaskPart) : null;

    const incomingReasoning =
      typeof payload.reasoning === 'string' && payload.reasoning.length > 0
        ? payload.reasoning
        : undefined;
    const prevReasoning = prev?.content.reasoning ?? '';
    const nextReasoning = incomingReasoning
      ? prevReasoning + incomingReasoning
      : prevReasoning || undefined;

    const next: SubagentTaskPart = {
      partId: prev?.partId ?? uuidv4(),
      type: 'subagent_task',
      createdAt: prev?.createdAt ?? Date.now(),
      content: {
        taskId,
        description:
          typeof payload.description === 'string' ? payload.description : prev?.content.description,
        subagentType:
          typeof payload.subagentType === 'string'
            ? payload.subagentType
            : prev?.content.subagentType,
        status: incomingStatus,
        result:
          typeof payload.result === 'string' && payload.result.length > 0
            ? payload.result
            : prev?.content.result,
        error:
          typeof payload.error === 'string' && payload.error.length > 0
            ? payload.error
            : prev?.content.error,
        reasoning: nextReasoning,
        children: prev?.content.children ?? [],
        structured:
          payload.structured && typeof payload.structured === 'object'
            ? (payload.structured as SubagentStructuredReport)
            : (prev?.content.structured ?? null),
      },
    };

    if (typeof idx === 'number') {
      this.parts = [...this.parts.slice(0, idx), next, ...this.parts.slice(idx + 1)];
    } else {
      this.parts = [...this.parts, next];
      this.partIndexByTaskId.set(taskId, this.parts.length - 1);
    }
    this.lastPartType = 'subagent_task';
  }

  private applySubagentToolEvent(
    taskId: string,
    payload: Record<string, unknown>,
    incomingStatus: 'tool_call' | 'tool_result',
  ): void {
    let idx = this.partIndexByTaskId.get(taskId);
    if (typeof idx !== 'number') {
      const placeholder: SubagentTaskPart = {
        partId: uuidv4(),
        type: 'subagent_task',
        createdAt: Date.now(),
        content: { taskId, status: 'running', children: [] },
      };
      this.parts = [...this.parts, placeholder];
      idx = this.parts.length - 1;
      this.partIndexByTaskId.set(taskId, idx);
    }
    const part = this.parts[idx] as SubagentTaskPart;
    const children: SubagentToolCall[] = [...(part.content.children ?? [])];
    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';

    if (incomingStatus === 'tool_call') {
      const args = parseJsonSafe(payload.arguments);
      const existIdx = children.findIndex((c) => c.toolCallId === toolCallId);
      const item: SubagentToolCall = {
        id: toolCallId || uuidv4(),
        toolCallId,
        name: typeof payload.toolName === 'string' ? payload.toolName : '',
        args,
        status: 'running',
      };
      if (existIdx === -1) children.push(item);
      else
        children[existIdx] = { ...children[existIdx], ...item, status: children[existIdx].status };
    } else {
      const success = payload.toolSuccess !== false;
      const result = payload.toolResult;
      const errorMessage =
        typeof payload.toolErrorMessage === 'string' ? payload.toolErrorMessage : undefined;
      const existIdx = children.findIndex((c) => c.toolCallId === toolCallId);
      if (existIdx === -1) {
        children.push({
          id: toolCallId || uuidv4(),
          toolCallId,
          name: typeof payload.toolName === 'string' ? payload.toolName : '',
          result,
          success,
          errorMessage,
          status: success ? 'done' : 'failed',
        });
      } else {
        children[existIdx] = {
          ...children[existIdx],
          result,
          success,
          errorMessage,
          status: success ? 'done' : 'failed',
        };
      }
    }

    const next: SubagentTaskPart = {
      ...part,
      content: { ...part.content, children },
    };
    this.parts = [...this.parts.slice(0, idx), next, ...this.parts.slice(idx + 1)];
    this.lastPartType = 'subagent_task';
  }

  private applyStateUpdate(stateType: string, data: unknown): void {
    switch (stateType) {
      case 'simple_analysis': {
        const text =
          typeof data === 'string'
            ? data
            : isObjectWithStringKey(data, 'simpleAnalysis')
              ? data.simpleAnalysis
              : '';
        if (text) this.appendOrMergeReasoningPart(text);
        break;
      }
      case 'tasks_initial': {
        if (Array.isArray(data)) {
          for (const task of data) {
            const taskId = isObjectWithStringKey(task, 'taskId')
              ? task.taskId
              : isObjectWithStringKey(task, 'id')
                ? task.id
                : '';
            this.upsertSubagentTaskPart({
              taskId,
              description: isObjectWithStringKey(task, 'description')
                ? task.description
                : undefined,
              status: isObjectWithStringKey(task, 'status') ? task.status : 'pending',
            });
          }
        }
        break;
      }
      case 'task_update': {
        this.upsertSubagentTaskPart((data ?? {}) as Record<string, unknown>);
        break;
      }
      case 'report': {
        const content =
          typeof data === 'string'
            ? data
            : isObjectWithStringKey(data, 'report')
              ? data.report
              : '';
        const title =
          isObjectWithStringKey(data, 'title') && data.title.length > 0 ? data.title : '研究报告';
        if (typeof content === 'string' && content.length > 0) {
          this.pushArtifactPart(title, content);
        }
        break;
      }
      default:
        break;
    }
  }

  private pushArtifactPart(title: string, markdown: string): void {
    const part: ArtifactPart = {
      partId: uuidv4(),
      type: 'artifact',
      createdAt: Date.now(),
      content: { title, markdown },
    };
    this.parts = [...this.parts, part];
    this.lastPartType = 'artifact';
  }

  /**
   * 启发式 artifact 抽取：
   *
   * 1. 优先识别显式标记（命中即精确提取并从 text part 剥离）：
   *    a) `<final_report>...</final_report>` 标签
   *    b) ```` ```final_report ... ``` ```` 代码块
   * 2. Fallback：若已有 artifact part 则跳过；否则把所有 text parts 拼接判断
   *    （>800 字符 + ≥2 个 H2 标题）→ 视为研究报告并追加 artifact part。
   */
  private maybeExtractArtifactFromText(): void {
    if (this.parts.some((p) => p.type === 'artifact')) return;

    const textIndices: number[] = [];
    let combined = '';
    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      if (part.type === 'text') {
        textIndices.push(i);
        combined += (combined ? '\n' : '') + part.content.text;
      }
    }
    if (combined.length === 0) return;

    const tagRegex = /<final_report>([\s\S]*?)<\/final_report>/;
    const tagMatch = combined.match(tagRegex);
    if (tagMatch) {
      const reportContent = tagMatch[1].trim();
      this.stripFromTextParts(textIndices, tagRegex);
      this.commitArtifact(reportContent);
      return;
    }

    const fenceRegex = /```final_report\s*\n([\s\S]*?)```/;
    const fenceMatch = combined.match(fenceRegex);
    if (fenceMatch) {
      const reportContent = fenceMatch[1].trim();
      this.stripFromTextParts(textIndices, fenceRegex);
      this.commitArtifact(reportContent);
      return;
    }

    if (combined.length <= 800) return;
    const h2Matches = combined.match(/^##\s+/gm);
    if (!h2Matches || h2Matches.length < 2) return;

    let title = '';
    const headingMatch = combined.match(/^#{1,2}\s+(.+?)\s*$/m);
    if (headingMatch && headingMatch[1]) title = headingMatch[1].trim();
    if (!title) title = (this.config.inputValue ?? '').slice(0, 20) || '研究报告';

    this.pushArtifactPart(title, combined);
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[StreamChatHandler] heuristic artifact extracted: title="${title}" len=${combined.length} h2=${h2Matches.length}`,
      );
    }
  }

  /** 把命中的 regex 段落从所有 text parts 内容中剥离（仅命中第一处） */
  private stripFromTextParts(textIndices: number[], regex: RegExp): void {
    let matched = false;
    const next = [...this.parts];
    for (const i of textIndices) {
      if (matched) break;
      const part = next[i];
      if (part.type !== 'text') continue;
      if (regex.test(part.content.text)) {
        next[i] = {
          ...part,
          content: { text: part.content.text.replace(regex, '').trim() },
        };
        matched = true;
      }
    }
    this.parts = next;
  }

  private commitArtifact(reportContent: string): void {
    let title = '';
    const headingMatch = reportContent.match(/^#{1,2}\s+(.+?)\s*$/m);
    if (headingMatch && headingMatch[1]) title = headingMatch[1].trim();
    if (!title) title = (this.config.inputValue ?? '').slice(0, 20) || '研究报告';
    this.pushArtifactPart(title, reportContent);
  }

  // ──────────────────────────────────────────────────────
  // flush（rAF 合帧）
  // ──────────────────────────────────────────────────────

  private rafHandle: number | null = null;
  private pendingFlush = false;

  private flushMessage(): void {
    this.pendingFlush = true;
    if (this.rafHandle !== null) return;

    const schedule =
      typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame.bind(window)
        : (cb: FrameRequestCallback): number => {
            const id = setTimeout(() => cb(performance.now()), 16);
            return Number(id);
          };

    this.rafHandle = schedule(() => {
      this.rafHandle = null;
      if (!this.pendingFlush) return;
      this.pendingFlush = false;
      this.commitFlush();
    });
  }

  private flushMessageSync(): void {
    if (this.rafHandle !== null) {
      const cancel =
        typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function'
          ? window.cancelAnimationFrame.bind(window)
          : (id: number): void => {
              clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
            };
      cancel(this.rafHandle);
      this.rafHandle = null;
    }
    this.pendingFlush = false;
    this.commitFlush();
  }

  private commitFlush(): void {
    const target = this.assistantMessageId;
    let mutated = false;
    const updateMessages = this.initialUpdateMessages.map((msg) => {
      if (msg.id !== target) return msg;
      mutated = true;
      return {
        ...msg,
        parts: this.parts.map((p) => clonePart(p)),
        interrupt: this.interrupt,
      };
    });
    if (!mutated) return;
    this.initialUpdateMessages = updateMessages;
    this.config.setCurrentMessages(updateMessages);
  }

  // error / cleanup
  private async handleError(error: unknown): Promise<void> {
    const err = error as { name?: string; message?: string };
    if (err?.name === 'AbortError' || err?.name === 'AGENT_STREAM_ABORTED') {
      console.log('Chat was Interrupted by user');
      if (this.config.onStreamComplete) {
        this.config.onStreamComplete({
          sessionId: this.sessionId,
          messageId: this.assistantMessageId,
        });
      }
    } else {
      console.error('Stream error:', error);

      if (this.config.onStreamError) {
        this.config.onStreamError(error);
      } else {
        this.appendOrMergeTextPart('出错了，哎嘿。');
        this.flushMessageSync();
      }
    }
  }

  private async cleanup(): Promise<void> {
    this.config.setIsChating(false);
    this.config.setAbortController(null);

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

// ──────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────

function clonePart(part: MessagePart): MessagePart {
  switch (part.type) {
    case 'subagent_task':
      return {
        ...part,
        content: {
          ...part.content,
          children: part.content.children
            ? part.content.children.map((c) => ({ ...c }))
            : undefined,
        },
      };
    case 'text':
    case 'reasoning':
      return { ...part, content: { ...part.content } };
    case 'tool_call':
      return { ...part, content: { ...part.content } };
    case 'tool_result':
      return { ...part, content: { ...part.content } };
    case 'file':
      return { ...part, content: { ...part.content } };
    case 'image':
      return { ...part, content: { ...part.content } };
    case 'artifact':
      return { ...part, content: { ...part.content } };
    default: {
      const _never: never = part;
      void _never;
      return part;
    }
  }
}

function parseJsonSafe(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function isObjectWithStringKey<K extends string>(data: unknown, key: K): data is Record<K, string> {
  return (
    typeof data === 'object' &&
    data !== null &&
    key in (data as Record<string, unknown>) &&
    typeof (data as Record<string, unknown>)[key] === 'string'
  );
}
