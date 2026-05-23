import { ChatMessageType, ChatSessionType } from '@/types';
import { UUIDTypes, v4 as uuidv4 } from 'uuid';
import apiClient from '../request/api';
import { deepResearchResultType } from '@/types';
import { processStatusType } from '@/store/deep-research-process-store';

import { createAgentEventStream, ClientAgentEventType } from '@/runtime';

export interface StreamChatConfig {
  /**
   * @deprecated v3 thread service 接管后，此字段不再被使用，保留仅为向后兼容。
   * 实际请求路径为 /api/threads/:tid/runs 与 /api/threads/:tid/runs/:rid/stream。
   */
  apiEndpoint?: string;
  agentType: 'basic' | 'search' | 'deep_research';
  mode: 'chat' | 'search' | 'deepResearch';
  callingMode: 'direct' | 'reEditCall' | 'recall' | 'resume';
  inputValue: string;
  isResume?: boolean; // 研究human中断恢复模式
  sessionId?: UUIDTypes;
  hasFiles?: boolean; // "chat模式是否携带文件"
  uploadedFiles?: any[]; // 上传的文件信息
  chatSessions: ChatSessionType[];
  currentMessages: ChatMessageType[];

  // 需要的全局store方法
  setIsChating: (loading: boolean) => void;
  setShouldAutoScroll: (scroll: boolean) => void;
  addChatSession: (session: ChatSessionType) => void;
  setCurrentSessionId: (id: UUIDTypes) => void;
  setCurrentMessages: (messages: ChatMessageType[]) => void;
  setAbortController: (controller: AbortController | null) => void;
  setCurrentDeepResearchId: (id: string) => void;

  // 自定义处理器
  onStreamData?: (data: any, accumulatedContent: string) => string;
  onStreamComplete?: (data: Record<string, any>) => void;
  onStreamError?: (error: any) => void;

  /**
   * 额外注入到后端的 metadata（与默认 metadata 合并，调用方覆盖优先）。
   * deep-research 入口通过该字段写入 `is_plan_mode / subagent_enabled / agent_name`
   * 三个 plan-mode 开关。
   */
  extraMetadata?: Record<string, unknown>;

  // 获取深度研究结果
  getDeepResearchResult?: (
    sessionId: UUIDTypes,
    messageId: number,
  ) => deepResearchResultType | undefined;

  getDeepResearchStatus?: () => processStatusType;
}

export class StreamChatHandler {
  private config: StreamChatConfig;
  private abortController: AbortController | null = null;
  private accumulatedContent = ''; //新的ai消息
  private sessionId: UUIDTypes = '';
  private assistantMessageId: number = 0;
  private initialUpdateMessages: ChatMessageType[] = [];
  private deepResearchResult: deepResearchResultType | undefined = undefined;
  private lastPushedContent: string | null = null;

  constructor(config: StreamChatConfig) {
    this.config = config;
  }

  async execute(): Promise<void> {
    if (this.config.inputValue === '' && this.config.isResume === undefined) return;

    await this.handleSession();

    this.setupAbortController();

    if (this.config.callingMode === 'direct') {
      this.initializeMessages();
    } else if (this.config.callingMode === 'resume') {
      this.resumeMessages();
    } else {
      this.reInitializeMessages();
    }

    await this.executeStreamRequest();
  }

  // 处理session逻辑：没有 chat_session 则创建；并以同一 UUID 在 thread service 侧幂等创建 thread。
  private async handleSession(): Promise<void> {
    this.sessionId = this.config.sessionId || '';

    if (!this.sessionId) {
      this.sessionId = uuidv4();
      const chat_session: ChatSessionType = {
        id: this.sessionId,
        seq_id: this.config.chatSessions.length + 1,
        title: this.config.inputValue.slice(0, 15),
        created_at: Date.now(),
        updated_at: Date.now(),
      };

      try {
        const res = await apiClient.post('/conversations/create_session', {
          chat_session: chat_session,
        });

        if (res.success) {
          this.config.addChatSession(chat_session);
          this.config.setCurrentSessionId(chat_session.id);
        }
      } catch (error) {
        console.error('Failed to create session:', error);
        throw error;
      }
    }
  }

  // 处理中断逻辑
  private setupAbortController(): void {
    this.abortController = new AbortController();
    this.config.setAbortController(this.abortController);
    this.config.setIsChating(true);
  }

  // dirct模式初始化user和ai信息
  private initializeMessages(): void {
    const newUserMessage: ChatMessageType = {
      id: this.config.currentMessages.length + 1,
      sessionId: this.sessionId,
      role: 'user',
      content: this.config.inputValue,
      mode: this.config.mode,
    };

    this.assistantMessageId = newUserMessage.id + 1;

    this.initialUpdateMessages = [
      ...this.config.currentMessages,
      newUserMessage,
      {
        id: this.assistantMessageId,
        sessionId: this.sessionId,
        role: 'assistant',
        content: '',
        mode: this.config.mode,
      } as ChatMessageType,
    ];

    this.config.setCurrentMessages(JSON.parse(JSON.stringify(this.initialUpdateMessages)));
    this.config.setShouldAutoScroll(true);
  }

  // recall和reEditCall模式下初始化user和ai消息
  private reInitializeMessages(): void {
    const len = this.config.currentMessages.length;

    if (this.config.callingMode === 'recall') {
      this.initialUpdateMessages = [
        ...this.config.currentMessages.slice(0, len - 1),
        {
          ...this.config.currentMessages[len - 1],
          content: '',
          mode: this.config.mode,
          deepResearchResult: undefined,
          researchStatus: 'failed',
        },
      ];
    } else if (this.config.callingMode === 'reEditCall') {
      this.initialUpdateMessages = [
        ...this.config.currentMessages.slice(0, len - 2),
        {
          ...this.config.currentMessages[len - 2],
          content: this.config.inputValue,
          mode: this.config.mode,
          deepResearchResult: undefined,
          researchStatus: 'failed',
        },
        {
          ...this.config.currentMessages[len - 1],
          content: '',
          mode: this.config.mode,
          deepResearchResult: undefined,
          researchStatus: 'failed',
        },
      ];
    }

    this.assistantMessageId = len;
    this.config.setCurrentMessages(JSON.parse(JSON.stringify(this.initialUpdateMessages)));
    this.config.setShouldAutoScroll(true);
  }

  // 研究过程决策恢复
  private resumeMessages(): void {
    const len = this.config.currentMessages.length;
    this.initialUpdateMessages = this.config.currentMessages;
    this.assistantMessageId = len;
    this.accumulatedContent = this.config.currentMessages[len - 1].content as string;
  }

  // 执行 SSE：v3 chat 合并端点 —— 一次 POST 即拿到事件流（服务端在内部完成 createThread + submitRun + subscribe）
  private async executeStreamRequest(): Promise<void> {
    try {
      const metadata: Record<string, any> = {
        sessionId: this.sessionId,
        hasFiles: this.config.hasFiles,
        uploadedFiles: this.config.uploadedFiles || [],
        deepResearchId: `dr-${this.sessionId}-${this.assistantMessageId}`,
        isResume: this.config.isResume,
        agentType: this.config.agentType,
        // 调用方注入的 plan-mode 三开关 / 其它扩展字段；
        // 放在末尾以便覆盖默认值（如某些场景显式禁用 subagent）。
        ...(this.config.extraMetadata ?? {}),
      };

      await this.processSseStream(`/api/v3/chat/${this.sessionId}`, {
        input: this.config.inputValue,
        agentType: this.config.agentType,
        displayName: this.config.inputValue.slice(0, 15) || 'New thread',
        metadata,
      });
    } catch (error) {
      await this.handleError(error);
    } finally {
      await this.cleanup();
    }
  }

  /**
   * 消费后端 ClientAgentEvent 流（POST SSE 订阅 v3 chat 合并端点）
   */
  private async processSseStream(streamUrl: string, body: Record<string, unknown>): Promise<void> {
    const stream = createAgentEventStream({
      endpoint: streamUrl,
      method: 'POST',
      body,
      signal: this.abortController!.signal,
    });

    const dispatchStreamData = (type: string, payload: unknown) => {
      const newContent = this.config.onStreamData?.({ type, payload }, this.accumulatedContent);
      // onStreamData 约定：返回 string 表示"应当作为新的 accumulatedContent"。
      // 大量 STATE_UPDATE 回调实际并不修改正文，只是顺手 `return accumulatedContent`，
      // 这里用值比较过滤掉这种"自反返回"，避免每帧都白白触发 setCurrentMessages。
      // 真正的幂等终点在 updateMessages() 内（lastPushedContent 指纹），
      // 这里属于第一道更便宜的剪枝。
      if (typeof newContent === 'string' && newContent !== this.accumulatedContent) {
        this.accumulatedContent = newContent;
        this.updateMessages();
      }
    };

    for await (const event of stream) {
      switch (event.eventType) {
        case ClientAgentEventType.STREAM_CHUNK: {
          this.accumulatedContent += event.payload.text;
          this.updateMessages();
          break;
        }

        case ClientAgentEventType.STATE_UPDATE: {
          if (!this.config.onStreamData) break;
          const { stateType, data } = event.payload;
          // simple_analysis → start_analyse；其余按 stateType 直接转发
          const dispatchType = stateType === 'simple_analysis' ? 'start_analyse' : stateType;
          dispatchStreamData(dispatchType, data);
          break;
        }

        case ClientAgentEventType.TASK_PROGRESS: {
          if (!this.config.onStreamData) break;
          dispatchStreamData('task_update', event.payload);
          break;
        }

        case ClientAgentEventType.HUMAN_INTERRUPT: {
          if (!this.config.onStreamData) break;
          dispatchStreamData('interrupt', event.payload);
          break;
        }

        case ClientAgentEventType.TOOL_CALL:
        case ClientAgentEventType.TOOL_RESULT: {
          // 工具调用展示能力暂未在 StreamChatHandler 中使用，先忽略
          break;
        }

        case ClientAgentEventType.ERROR: {
          console.error('[StreamChatHandler] stream error:', event.payload.errorMessage);
          // 抛出以走 handleError 分支
          throw Object.assign(new Error(event.payload.errorMessage), {
            name: event.payload.errorCode,
          });
        }

        case ClientAgentEventType.START:
        case ClientAgentEventType.HEARTBEAT:
          // start / heartbeat 仅作保活，不需 UI 处理
          break;

        case ClientAgentEventType.END: {
          console.log('[StreamChatHandler] stream completed');
          return;
        }

        default: {
          // exhaustive check
          const _never: never = event;
          void _never;
        }
      }
    }
  }

  // 更新UI
  private updateMessages(): void {
    // 幂等：assistant content 与上次推送相同 → 跳过。
    // SSE 的 STATE_UPDATE 帧（task_update / report 等）大多不修改正文，
    // 但旧实现仍会调用 setCurrentMessages，引发 React 整棵消息树重渲染。
    // 高频场景下叠加 useEffect/订阅链的副作用，会导致 commit 数堆积、
    // 最终撞到 React "Maximum update depth exceeded" 护栏。
    if (this.accumulatedContent === this.lastPushedContent) {
      return;
    }
    this.lastPushedContent = this.accumulatedContent;

    const updateMessages = this.initialUpdateMessages.map((msg) =>
      msg.id === this.assistantMessageId ? { ...msg, content: this.accumulatedContent } : msg,
    );
    this.config.setCurrentMessages(JSON.parse(JSON.stringify(updateMessages)));
  }

  //处理中断和错误
  private async handleError(error: any): Promise<void> {
    if (error.name === 'AbortError' || error.name === 'AGENT_STREAM_ABORTED') {
      console.log('Chat was Interrupted by user');
      if (this.config.onStreamComplete) {
        //自定义结束处理
        this.config.onStreamComplete({
          finalContent: this.accumulatedContent,
          sessionId: this.sessionId,
          messageId: this.assistantMessageId,
        });
      }
    } else {
      console.error('Stream error:', error);

      if (this.config.onStreamError) {
        //自定义错误处理
        this.config.onStreamError(error);
      } else {
        // 默认错误处理
        const updateMessages = this.initialUpdateMessages.map((msg) =>
          msg.id === this.assistantMessageId
            ? { ...msg, content: '出错了，哎嘿。', researchStatus: 'failed' }
            : msg,
        );
        this.accumulatedContent = '出错了，哎嘿。';
        this.config.setCurrentMessages(JSON.parse(JSON.stringify(updateMessages)));
      }
    }
  }

  private async cleanup(): Promise<void> {
    this.config.setIsChating(false);
    this.config.setAbortController(null);

    if (this.accumulatedContent) {
      if (this.abortController?.signal.aborted) this.accumulatedContent += '\n 消息已被停止。';
      await this.saveMessages();
    }

    if (this.config.onStreamComplete) {
      this.config.onStreamComplete({
        finalContent: this.accumulatedContent,
        sessionId: this.sessionId,
        messageId: this.assistantMessageId,
      });
    }
  }

  //数据库保存
  private async saveMessages(): Promise<void> {
    const newUserMessage = this.initialUpdateMessages.findLast((msg) => msg.role === 'user');
    const newAssistantMessage: ChatMessageType = {
      id: this.assistantMessageId,
      sessionId: this.sessionId,
      role: 'assistant',
      content: this.accumulatedContent,
      mode: this.config.mode,
    };

    if (
      this.config.mode === 'deepResearch' &&
      this.config.getDeepResearchResult
      // &&this.config.getDeepResearchStatus?.() === "end"
    ) {
      this.deepResearchResult = this.config.getDeepResearchResult(
        this.sessionId,
        this.assistantMessageId,
      );
      if (this.deepResearchResult) {
        newAssistantMessage.deepResearchResult = this.deepResearchResult;
        newAssistantMessage.researchStatus = 'finished';
        const updateMessages = this.initialUpdateMessages.map((msg) =>
          msg.id === this.assistantMessageId ? newAssistantMessage : msg,
        );
        this.config.setCurrentMessages(JSON.parse(JSON.stringify(updateMessages)));
      }
    }

    try {
      if (this.config.callingMode === 'direct') {
        await apiClient.post('/conversations/add_messages', {
          chat_messages: [newUserMessage, newAssistantMessage],
          hasFiles: this.config.hasFiles,
          uploadedFiles: this.config.uploadedFiles || [],
        });
      } else {
        await apiClient.post('/conversations/update_messages', {
          chat_messages: [newUserMessage, newAssistantMessage],
          hasFiles: this.config.hasFiles,
          uploadedFiles: this.config.uploadedFiles || [],
        });
      }
    } catch (error) {
      console.error('Failed to save messages:', error);
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
