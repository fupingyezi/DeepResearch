import {
  ChatMessageType,
  ChatSessionType,
  ChatUploadedFileRef,
  MessagePart,
  SubagentToolCall,
  SubagentStructuredReport,
} from '@/types';
import type { ModelPresetName } from '@/config/models';
import { UUIDTypes, v4 as uuidv4 } from 'uuid';

import { createAgentEventStream, ClientAgentEventType } from '@/runtime';
import { extractFinalMessageParts } from './final-message-extract';
import {
  parseJsonSafe,
  hasMeaningfulArgs,
  isObjectWithKey,
  createRafFlusher,
  type RafFlusher,
} from '@/utils/common';

export interface StreamChatConfig {
  operation?: 'resume' | 'recall' | 'reEditCall';
  inputValue: string;
  /** operation === 'resume' 时使用：'确认'/'拒绝'等 human-in-the-loop 决策文本 */
  resumeDecision?: string;
  sessionId?: UUIDTypes;
  /** 已上传文件的元信息（前端上传后拿到，转成 message.contents 中的 file/image block，仅传 fileId） */
  uploadedFiles?: ChatUploadedFileRef[];
  chatSessions: ChatSessionType[];
  currentMessages: ChatMessageType[];

  setIsChating: (loading: boolean) => void;
  setShouldAutoScroll: (scroll: boolean) => void;
  addChatSession: (session: ChatSessionType) => void;
  setCurrentSessionId: (id: UUIDTypes) => void;
  setCurrentMessages: (messages: ChatMessageType[]) => void;
  setAbortController: (controller: AbortController | null) => void;

  /** 模型预设标识（映射成 configuration.model.value 等运行配置） */
  model?: ModelPresetName;

  onStreamComplete?: (data: Record<string, unknown>) => void;
  onStreamError?: (error: unknown) => void;
}

type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;
type SubagentTaskPart = Extract<MessagePart, { type: 'subagent_task' }>;
type ArtifactPart = Extract<MessagePart, { type: 'artifact' }>;

/**
 * 深拷贝单个 MessagePart（用于把 class 内部 parts 写回 store 时切断引用，
 * 避免 React 因为同 ref 不重渲染）。
 */
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
    case 'task_summary':
      return { ...part, content: { ...part.content } };
    default: {
      const _never: never = part;
      void _never;
      return part;
    }
  }
}

/**
 * StreamChatHandler
 *
 * 把 SSE 事件实时聚合为消息的 parts[]
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
    this.initialUpdateMessages = this.config.currentMessages.map((message, idx) =>
      idx === len - 1 && message.role === 'assistant'
        ? { ...message, parts: this.parts.map((p) => clonePart(p)), interrupt: null }
        : message,
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
          this.parts = extractFinalMessageParts(this.parts, this.config.inputValue ?? '');
          this.lastPartType = this.parts[this.parts.length - 1]?.type ?? this.lastPartType;
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
      this.sessionId = realSessionId;
      this.config.setCurrentSessionId(realSessionId);
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
      this.config.setCurrentMessages(updated);
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

  // parts 维护
  // 合并策略：在 parts 数组中**自尾部反向**寻找最近的同类型 part。
  private appendOrMergeTextPart(text: string): void {
    const idx = this.findMergeTarget('text');
    if (idx >= 0) {
      const last = this.parts[idx] as Extract<MessagePart, { type: 'text' }>;
      this.parts = [
        ...this.parts.slice(0, idx),
        { ...last, content: { text: last.content.text + text } },
        ...this.parts.slice(idx + 1),
      ];
      this.lastPartType = 'text';
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
    const idx = this.findMergeTarget('reasoning');
    if (idx >= 0) {
      const last = this.parts[idx] as Extract<MessagePart, { type: 'reasoning' }>;
      this.parts = [
        ...this.parts.slice(0, idx),
        { ...last, content: { text: last.content.text + text } },
        ...this.parts.slice(idx + 1),
      ];
      this.lastPartType = 'reasoning';
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

  /**
   * 自尾向前找可合并的同类型 part 下标
   */
  private findMergeTarget(target: 'text' | 'reasoning'): number {
    const other = target === 'text' ? 'reasoning' : 'text';
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const t = this.parts[i].type;
      if (t === target) return i;
      if (t === other) return -1;
      if (t === 'subagent_task' || t === 'tool_call' || t === 'tool_result') continue;
      return -1;
    }
    return -1;
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
      // args 为空且无 result → 跳过入 children；
      if (!hasMeaningfulArgs(args)) return;
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
            : isObjectWithKey(data, 'simpleAnalysis')
              ? data.simpleAnalysis
              : '';
        if (text) this.appendOrMergeReasoningPart(text);
        break;
      }
      case 'tasks_initial': {
        if (Array.isArray(data)) {
          for (const task of data) {
            const taskId = isObjectWithKey(task, 'taskId')
              ? task.taskId
              : isObjectWithKey(task, 'id')
                ? task.id
                : '';
            this.upsertSubagentTaskPart({
              taskId,
              description: isObjectWithKey(task, 'description') ? task.description : undefined,
              status: isObjectWithKey(task, 'status') ? task.status : 'pending',
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
          typeof data === 'string' ? data : isObjectWithKey(data, 'report') ? data.report : '';
        const title =
          isObjectWithKey(data, 'title') && data.title.length > 0 ? data.title : '研究报告';
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

  // flush（rAF 合帧）
  private flushMessage(): void {
    this.flusher.schedule();
  }

  private flushMessageSync(): void {
    this.flusher.flushSync();
  }

  private commitFlush(): void {
    const target = this.assistantMessageId;
    let mutated = false;
    const updateMessages = this.initialUpdateMessages.map((message) => {
      if (message.id !== target) return message;
      mutated = true;
      return {
        ...message,
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
