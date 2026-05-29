import {
  ChatMessageType,
  ChatSessionType,
  CoTStep,
  MessageArtifact,
  MessageTimeline,
  SubagentStructuredReport,
  SubagentToolCall,
} from '@/types';
import { UUIDTypes, v4 as uuidv4 } from 'uuid';
import apiClient from '../request/api';

import { createAgentEventStream, ClientAgentEventType } from '@/runtime';

export interface StreamChatConfig {
  /** 仅作历史标识，实际请求路径固定为 /api/v3/chat/:tid */
  apiEndpoint?: string;
  callingMode: 'direct' | 'reEditCall' | 'recall' | 'resume';
  inputValue: string;
  /** 研究 human 中断恢复模式 */
  isResume?: boolean;
  sessionId?: UUIDTypes;
  hasFiles?: boolean;
  uploadedFiles?: any[];
  chatSessions: ChatSessionType[];
  currentMessages: ChatMessageType[];

  // 全局 store 注入
  setIsChating: (loading: boolean) => void;
  setShouldAutoScroll: (scroll: boolean) => void;
  addChatSession: (session: ChatSessionType) => void;
  setCurrentSessionId: (id: UUIDTypes) => void;
  setCurrentMessages: (messages: ChatMessageType[]) => void;
  setAbortController: (controller: AbortController | null) => void;

  /** 通用业务 metadata（如 modelKey 等） */
  extraMetadata?: Record<string, any>;

  // 自定义 hook
  onStreamComplete?: (data: Record<string, any>) => void;
  onStreamError?: (error: any) => void;
}

/**
 * StreamChatHandler（deer-flow 对齐版）
 *
 * 所有后端事件按到达时序追加为 `timeline.steps[]`，由 ChatMessageBubble 内联
 * 渲染（reasoning / tool_call / subagent_task）。前端不再有 simpleAnalysis /
 * tasks / report 等概念字段，也不再做 mode 屏蔽。
 *
 * - STREAM_CHUNK.text       → 累积到 accumulatedContent（正文）
 * - STREAM_CHUNK.reasoning  → append/合并最后一个 reasoning step
 * - TOOL_CALL               → 新增 tool_call step（status=running）
 * - TOOL_RESULT             → 通过 toolCallId 关联回写 result
 * - TASK_PROGRESS           → upsert subagent_task step
 * - STATE_UPDATE.simple_analysis  → 一条 reasoning step
 * - STATE_UPDATE.tasks_initial    → 批量补 subagent_task 占位
 * - STATE_UPDATE.task_update      → upsert subagent_task step
 * - STATE_UPDATE.report           → 写入 message.artifact，status=end
 * - HUMAN_INTERRUPT         → timeline.interrupt，status=interrupt
 */
export class StreamChatHandler {
  private config: StreamChatConfig;
  private abortController: AbortController | null = null;
  private accumulatedContent = ''; // assistant 消息正文
  private sessionId: UUIDTypes = '';
  private assistantMessageId: number = 0;
  private initialUpdateMessages: ChatMessageType[] = [];

  /** 流式期间维护在内存里的 timeline；每次更新都同步到对应消息 */
  private timeline: MessageTimeline = { steps: [], status: 'idle' };
  /** 最终产物（report 等），同步到对应消息的 artifact 字段 */
  private artifact: MessageArtifact | null = null;

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

  // session / messages 初始化

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

  private setupAbortController(): void {
    this.abortController = new AbortController();
    this.config.setAbortController(this.abortController);
    this.config.setIsChating(true);
  }

  private initializeMessages(): void {
    const newUserMessage: ChatMessageType = {
      id: this.config.currentMessages.length + 1,
      sessionId: this.sessionId,
      role: 'user',
      content: this.config.inputValue,
    };

    this.assistantMessageId = newUserMessage.id + 1;
    this.timeline = { steps: [], status: 'processing' };

    this.initialUpdateMessages = [
      ...this.config.currentMessages,
      newUserMessage,
      {
        id: this.assistantMessageId,
        sessionId: this.sessionId,
        role: 'assistant',
        content: '',
        timeline: this.cloneTimeline(),
      } as ChatMessageType,
    ];

    this.config.setCurrentMessages(this.initialUpdateMessages);
    this.config.setShouldAutoScroll(true);
  }

  private reInitializeMessages(): void {
    const len = this.config.currentMessages.length;
    this.timeline = { steps: [], status: 'processing' };

    if (this.config.callingMode === 'recall') {
      this.initialUpdateMessages = [
        ...this.config.currentMessages.slice(0, len - 1),
        {
          ...this.config.currentMessages[len - 1],
          content: '',
          artifact: undefined,
          timeline: this.cloneTimeline(),
        },
      ];
    } else if (this.config.callingMode === 'reEditCall') {
      this.initialUpdateMessages = [
        ...this.config.currentMessages.slice(0, len - 2),
        {
          ...this.config.currentMessages[len - 2],
          content: this.config.inputValue,
        },
        {
          ...this.config.currentMessages[len - 1],
          content: '',
          artifact: undefined,
          timeline: this.cloneTimeline(),
        },
      ];
    }

    this.assistantMessageId = len;
    this.config.setCurrentMessages(this.initialUpdateMessages);
    this.config.setShouldAutoScroll(true);
  }

  private resumeMessages(): void {
    const len = this.config.currentMessages.length;
    const last = this.config.currentMessages[len - 1];
    // 继承上一轮 timeline（interrupt → processing）
    if (last?.role === 'assistant' && last.timeline) {
      this.timeline = {
        steps: [...last.timeline.steps],
        status: 'processing',
        interrupt: null,
      };
    } else {
      this.timeline = { steps: [], status: 'processing' };
    }
    this.initialUpdateMessages = this.config.currentMessages.map((msg, idx) =>
      idx === len - 1 && msg.role === 'assistant'
        ? { ...msg, timeline: this.cloneTimeline() }
        : msg,
    );
    this.assistantMessageId = (last?.id as number) ?? len;
    this.accumulatedContent = (last?.content as string) ?? '';
    this.artifact = last?.artifact ?? null;
  }

  // SSE 处理

  private async executeStreamRequest(): Promise<void> {
    try {
      const metadata: Record<string, any> = {
        sessionId: this.sessionId,
        hasFiles: this.config.hasFiles,
        uploadedFiles: this.config.uploadedFiles || [],
        deepResearchId: `dr-${this.sessionId}-${this.assistantMessageId}`,
        isResume: this.config.isResume,
        ...(this.config.extraMetadata ?? {}),
      };

      await this.processSseStream(`/api/v3/chat/${this.sessionId}`, {
        input: this.config.inputValue,
        displayName: this.config.inputValue.slice(0, 15) || 'New thread',
        metadata,
      });
    } catch (error) {
      await this.handleError(error);
    } finally {
      await this.cleanup();
    }
  }

  private async processSseStream(streamUrl: string, body: Record<string, any>): Promise<void> {
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
            this.appendReasoning(reasoning);
          }
          if (typeof text === 'string' && text.length > 0) {
            this.accumulatedContent += text;
          }
          this.flushMessage();
          break;
        }

        case ClientAgentEventType.TOOL_CALL: {
          const { toolCallId, toolName, arguments: argsStr } = event.payload;
          let parsedArgs: any = undefined;
          if (typeof argsStr === 'string') {
            try {
              parsedArgs = JSON.parse(argsStr);
            } catch {
              parsedArgs = argsStr;
            }
          }
          this.timeline.steps = [
            ...this.timeline.steps,
            {
              kind: 'tool_call',
              id: toolCallId || uuidv4(),
              toolCallId,
              name: toolName,
              args: parsedArgs,
              status: 'running',
            },
          ];
          this.timeline.status = 'processing';
          this.flushMessage();
          break;
        }

        case ClientAgentEventType.TOOL_RESULT: {
          const { toolCallId, result, success, errorMessage } = event.payload;
          this.timeline.steps = this.timeline.steps.map((step) =>
            step.kind === 'tool_call' && step.toolCallId === toolCallId
              ? {
                  ...step,
                  result,
                  success,
                  errorMessage,
                  status: success === false ? 'failed' : 'done',
                }
              : step,
          );
          this.flushMessage();
          break;
        }

        case ClientAgentEventType.STATE_UPDATE: {
          const { stateType, data } = event.payload;
          this.applyStateUpdate(stateType, data);
          break;
        }

        case ClientAgentEventType.TASK_PROGRESS: {
          this.upsertSubagentTask(event.payload);
          this.flushMessage();
          break;
        }

        case ClientAgentEventType.HUMAN_INTERRUPT: {
          this.timeline.interrupt = event.payload;
          this.timeline.status = 'interrupt';
          this.flushMessage();
          break;
        }

        case ClientAgentEventType.ERROR: {
          console.error('[StreamChatHandler] stream error:', event.payload.errorMessage);
          throw Object.assign(new Error(event.payload.errorMessage), {
            name: event.payload.errorCode,
          });
        }

        case ClientAgentEventType.START:
        case ClientAgentEventType.HEARTBEAT:
          break;

        case ClientAgentEventType.END: {
          if (this.timeline.status === 'processing') {
            this.timeline.status = 'end';
          }
          // 启发式 artifact 抽取（仅当后端没有通过 STATE_UPDATE.report
          // 显式塞入 artifact 时才尝试）：
          // 较长且含层级标题的 markdown 视为"研究报告"，自动塞入右侧产物面板。
          this.maybeExtractArtifactFromContent();
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

  // timeline 更新

  /** 把 reasoning 文本合并/追加到最后一个 reasoning step */
  private appendReasoning(text: string): void {
    const last = this.timeline.steps[this.timeline.steps.length - 1];
    if (last && last.kind === 'reasoning') {
      this.timeline.steps = [
        ...this.timeline.steps.slice(0, -1),
        { ...last, text: last.text + text },
      ];
    } else {
      this.timeline.steps = [...this.timeline.steps, { kind: 'reasoning', id: uuidv4(), text }];
    }
    this.timeline.status = 'processing';
  }

  /**
   * upsert 一个 subagent_task step（按 taskId 关联）
   *
   * 支持的 status：
   *  - 'started' / 'running' / 'completed' / 'failed' / 'cancelled' / 'timed_out'
   *  - 'tool_call' / 'tool_result'：subagent 内部工具调用，挂到该 task 的
   *    children 数组下；不会改变父 task 自身的状态。
   *  - 'pending'：占位（仅来自 STATE_UPDATE.tasks_initial）
   */
  private upsertSubagentTask(payload: any): void {
    const taskId: string = payload?.taskId ?? '';
    const incomingStatus: string = payload?.status ?? 'running';

    const idx = this.timeline.steps.findIndex(
      (s) => s.kind === 'subagent_task' && s.taskId === taskId,
    );
    const prev =
      idx === -1 ? null : (this.timeline.steps[idx] as Extract<CoTStep, { kind: 'subagent_task' }>);

    // 子工具调用：维护 children 数组，不动父任务状态
    if (incomingStatus === 'tool_call' || incomingStatus === 'tool_result') {
      const next = this.applySubToolEvent(prev, payload, incomingStatus);
      this.writeSubagentTaskStep(idx, next);
      this.timeline.status = 'processing';
      return;
    }

    // 终态/进行态：正常 upsert
    const incomingReasoning =
      typeof payload?.reasoning === 'string' && payload.reasoning.length > 0
        ? payload.reasoning
        : undefined;
    // running 时追加 reasoning（多次 ai_message 会逐步拼合）
    const prevReasoning = prev?.reasoning ?? '';
    const nextReasoning = incomingReasoning
      ? prevReasoning + incomingReasoning
      : prevReasoning || undefined;

    const next: CoTStep = {
      kind: 'subagent_task',
      id: prev?.id ?? taskId ?? uuidv4(),
      taskId,
      description:
        typeof payload?.description === 'string' ? payload.description : prev?.description,
      subagentType:
        typeof payload?.subagentType === 'string' ? payload.subagentType : prev?.subagentType,
      status: incomingStatus,
      result:
        typeof payload?.result === 'string' && payload.result.length > 0
          ? payload.result
          : prev?.result,
      error:
        typeof payload?.error === 'string' && payload.error.length > 0
          ? payload.error
          : prev?.error,
      children: prev?.children ?? [],
      structured:
        payload?.structured && typeof payload.structured === 'object'
          ? (payload.structured as SubagentStructuredReport)
          : prev?.structured,
      reasoning: nextReasoning,
    };

    this.writeSubagentTaskStep(idx, next);
    this.timeline.status = 'processing';
  }

  /**
   * 把子工具调用事件应用到当前 subagent_task 上。
   * - 如果 prev 不存在，就先建一个占位 task，再把这条子调用挂上去（容错时序乱序）
   * - tool_call：children push 一条 status='running' 的子项
   * - tool_result：找到匹配的 toolCallId 子项，写回 result + status
   */
  private applySubToolEvent(
    prev: Extract<CoTStep, { kind: 'subagent_task' }> | null,
    payload: any,
    incomingStatus: 'tool_call' | 'tool_result',
  ): CoTStep {
    const taskId: string = payload?.taskId ?? '';
    const baseId = prev?.id ?? taskId ?? uuidv4();
    const children: SubagentToolCall[] = [...(prev?.children ?? [])];

    const toolCallId: string = payload?.toolCallId ?? '';

    if (incomingStatus === 'tool_call') {
      // 解析 args（来自 JSON 字符串）
      let parsedArgs: any = undefined;
      const rawArgs = payload?.arguments;
      if (typeof rawArgs === 'string') {
        try {
          parsedArgs = JSON.parse(rawArgs);
        } catch {
          parsedArgs = rawArgs;
        }
      } else if (rawArgs && typeof rawArgs === 'object') {
        parsedArgs = rawArgs;
      }
      const exists = children.findIndex((c) => c.toolCallId === toolCallId);
      const item: SubagentToolCall = {
        id: toolCallId || uuidv4(),
        toolCallId,
        name: payload?.toolName ?? '',
        args: parsedArgs,
        status: 'running',
      };
      if (exists === -1) {
        children.push(item);
      } else {
        children[exists] = { ...children[exists], ...item, status: children[exists].status };
      }
    } else {
      // tool_result：找到对应子项写回
      const exists = children.findIndex((c) => c.toolCallId === toolCallId);
      const success = payload?.toolSuccess !== false;
      const result = payload?.toolResult;
      const errMsg =
        typeof payload?.toolErrorMessage === 'string' ? payload.toolErrorMessage : undefined;
      if (exists === -1) {
        children.push({
          id: toolCallId || uuidv4(),
          toolCallId,
          name: payload?.toolName ?? '',
          result,
          success,
          errorMessage: errMsg,
          status: success ? 'done' : 'failed',
        });
      } else {
        children[exists] = {
          ...children[exists],
          result,
          success,
          errorMessage: errMsg,
          status: success ? 'done' : 'failed',
        };
      }
    }

    return {
      kind: 'subagent_task',
      id: baseId,
      taskId,
      description: prev?.description,
      subagentType: prev?.subagentType,
      // 子工具事件不动父状态；若 prev 不存在，给个 'running' 占位
      status: prev?.status ?? 'running',
      result: prev?.result,
      error: prev?.error,
      children,
      structured: prev?.structured,
      reasoning: prev?.reasoning,
    };
  }

  /** 把 subagent_task step 写回 timeline.steps（idx===-1 时 push） */
  private writeSubagentTaskStep(idx: number, step: CoTStep): void {
    if (idx === -1) {
      this.timeline.steps = [...this.timeline.steps, step];
    } else {
      this.timeline.steps = [
        ...this.timeline.steps.slice(0, idx),
        step,
        ...this.timeline.steps.slice(idx + 1),
      ];
    }
  }

  private applyStateUpdate(stateType: string, data: any): void {
    switch (stateType) {
      case 'simple_analysis': {
        const text =
          typeof data === 'string'
            ? data
            : typeof data?.simpleAnalysis === 'string'
              ? data.simpleAnalysis
              : '';
        if (text) this.appendReasoning(text);
        this.flushMessage();
        break;
      }
      case 'tasks_initial': {
        if (Array.isArray(data)) {
          for (const task of data) {
            this.upsertSubagentTask({
              taskId: task?.taskId ?? task?.id ?? '',
              description: task?.description,
              status: task?.status ?? 'pending',
            });
          }
        }
        this.flushMessage();
        break;
      }
      case 'task_update': {
        this.upsertSubagentTask(data);
        this.flushMessage();
        break;
      }
      case 'report': {
        const content = typeof data === 'string' ? data : data?.report;
        const title =
          typeof data === 'object' && data && typeof data.title === 'string'
            ? data.title
            : '研究报告';
        if (typeof content === 'string' && content.length > 0) {
          this.artifact = { title, content };
        }
        this.timeline.status = 'end';
        this.flushMessage();
        break;
      }
      case 'research_target':
      case 'custom':
      default:
        // 其余 state_update 统一忽略（与 deer-flow 对齐：不再前端做概念分支）
        break;
    }
  }

  private cloneTimeline(): MessageTimeline {
    return {
      steps: this.timeline.steps.map((s) => {
        if (s.kind === 'subagent_task') {
          return {
            ...s,
            children: s.children ? s.children.map((c) => ({ ...c })) : undefined,
          } as CoTStep;
        }
        return { ...s } as CoTStep;
      }),
      status: this.timeline.status,
      interrupt: this.timeline.interrupt,
    };
  }

  // 启发式 artifact 抽取

  /**
   * 精确 + 启发式 artifact 抽取：
   *
   * 1. **优先识别显式标记**（命中即精确提取并从正文剥离）：
   *    a) `<final_report>...</final_report>` HTML 标签包裹（提示词约定）
   *    b) ```` ```final_report ... ``` ```` 代码块包裹（LLM 偶尔会偏成这种）
   * 2. **Fallback 启发式**：无标记时沿用原逻辑（>800字符 + ≥2个##标题）。
   */
  private maybeExtractArtifactFromContent(): void {
    if (this.artifact) return;
    const text = this.accumulatedContent ?? '';

    // ① 精确模式 A：<final_report>...</final_report>
    const tagRegex = /<final_report>([\s\S]*?)<\/final_report>/;
    const tagMatch = text.match(tagRegex);
    if (tagMatch) {
      const reportContent = tagMatch[1].trim();
      this.accumulatedContent = text.replace(tagRegex, '').trim();
      this.commitArtifact(reportContent, '<final_report>');
      return;
    }

    // ① 精确模式 B：```final_report ... ``` 代码块
    const fenceRegex = /```final_report\s*\n([\s\S]*?)```/;
    const fenceMatch = text.match(fenceRegex);
    if (fenceMatch) {
      const reportContent = fenceMatch[1].trim();
      this.accumulatedContent = text.replace(fenceRegex, '').trim();
      this.commitArtifact(reportContent, 'final_report fence');
      return;
    }

    // ② Fallback：原启发式逻辑
    if (text.length <= 800) return;

    const h2Matches = text.match(/^##\s+/gm);
    if (!h2Matches || h2Matches.length < 2) return;

    // 抽标题：首个 `# ` 或 `## ` 行的内容
    let title = '';
    const headingMatch = text.match(/^#{1,2}\s+(.+?)\s*$/m);
    if (headingMatch && headingMatch[1]) {
      title = headingMatch[1].trim();
    }
    if (!title) {
      title = (this.config.inputValue ?? '').slice(0, 20) || '研究报告';
    }

    this.artifact = { title, content: text };
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[StreamChatHandler] heuristic artifact extracted: title="${title}" len=${text.length} h2=${h2Matches.length}`,
      );
    }
  }

  /** 共用：根据已剥离出的 reportContent 抽标题并写入 artifact。 */
  private commitArtifact(reportContent: string, source: string): void {
    let title = '';
    const headingMatch = reportContent.match(/^#{1,2}\s+(.+?)\s*$/m);
    if (headingMatch && headingMatch[1]) {
      title = headingMatch[1].trim();
    }
    if (!title) {
      title = (this.config.inputValue ?? '').slice(0, 20) || '研究报告';
    }

    this.artifact = { title, content: reportContent };
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[StreamChatHandler] ${source} artifact extracted: title="${title}" len=${reportContent.length}`,
      );
    }
  }

  // 把当前 accumulatedContent + timeline + artifact 推送到 store。

  private rafHandle: number | null = null;
  private pendingFlush = false;

  /** 调度一次 rAF 合并 flush；同一帧内多次调用只生效一次。 */
  private flushMessage(): void {
    this.pendingFlush = true;
    if (this.rafHandle !== null) return;

    const schedule =
      typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame.bind(window)
        : (cb: FrameRequestCallback): number => {
            // SSR 环境：用 setTimeout 模拟 16ms 一帧；Node setTimeout 返回 Timeout，
            // 转成 number 以满足 requestAnimationFrame 的返回类型契约。
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

  /** 同步 flush（用于流末尾、错误等需要立即落地的场景）。 */
  private flushMessageSync(): void {
    if (this.rafHandle !== null) {
      const cancel =
        typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function'
          ? window.cancelAnimationFrame.bind(window)
          : (id: number): void => {
              // SSR 环境：clearTimeout 在 Node 期望 Timeout 类型，但运行时接受数字 id
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
      if (msg.id !== target) return msg; // 关键：保持原引用
      mutated = true;
      return {
        ...msg,
        content: this.accumulatedContent,
        timeline: this.cloneTimeline(),
        artifact: this.artifact ?? msg.artifact,
      };
    });
    // 找不到 assistant 消息（异常重置场景）就不写，避免无意义的列表新引用
    if (!mutated) return;
    this.initialUpdateMessages = updateMessages;
    this.config.setCurrentMessages(updateMessages);
  }

  // error / cleanup

  private async handleError(error: any): Promise<void> {
    if (error.name === 'AbortError' || error.name === 'AGENT_STREAM_ABORTED') {
      console.log('Chat was Interrupted by user');
      if (this.config.onStreamComplete) {
        this.config.onStreamComplete({
          finalContent: this.accumulatedContent,
          sessionId: this.sessionId,
          messageId: this.assistantMessageId,
        });
      }
    } else {
      console.error('Stream error:', error);

      if (this.config.onStreamError) {
        this.config.onStreamError(error);
      } else {
        this.timeline.status = 'failed';
        this.accumulatedContent = '出错了，哎嘿。';
        this.flushMessageSync();
      }
    }
  }

  private async cleanup(): Promise<void> {
    this.config.setIsChating(false);
    this.config.setAbortController(null);

    if (this.accumulatedContent || this.artifact) {
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

  private async saveMessages(): Promise<void> {
    const newUserMessage = this.initialUpdateMessages.findLast((msg) => msg.role === 'user');
    const newAssistantMessage: ChatMessageType = {
      id: this.assistantMessageId,
      sessionId: this.sessionId,
      role: 'assistant',
      content: this.accumulatedContent,
      timeline: this.cloneTimeline(),
      artifact: this.artifact ?? undefined,
    };

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
