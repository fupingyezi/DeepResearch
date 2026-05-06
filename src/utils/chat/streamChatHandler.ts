import { ChatMessageType, ChatSessionType } from "@/types";
import { UUIDTypes, v4 as uuidv4 } from "uuid";
import apiClient from "../request/api";
import { deepResearchResultType } from "@/types";
import { AgentEventType } from "@/types/agentEvent";
import { processStatusType } from "@/store/deepResearchProcessStore";
import {
  EventConsumer,
  createLlmStreamHandler,
  createStateUpdateHandler,
  createTaskProgressHandler,
  createHumanInterruptHandler,
  createLifecycleHandler,
  createErrorHandler,
} from "./EventConsumer";

export interface StreamChatConfig {
  apiEndpoint: string;
  agentType: "basic" | "search" | "deep_research";
  mode: "chat" | "search" | "deepResearch";
  callingMode: "direct" | "reEditCall" | "recall" | "resume";
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

  // 获取深度研究结果
  getDeepResearchResult?: (
    sessionId: UUIDTypes,
    messageId: number
  ) => deepResearchResultType | undefined;

  getDeepResearchStatus?: () => processStatusType;
}

export class StreamChatHandler {
  private config: StreamChatConfig;
  private abortController: AbortController | null = null;
  private accumulatedContent = ""; //新的ai消息
  private sessionId: UUIDTypes = "";
  private assistantMessageId: number = 0;
  private initialUpdateMessages: ChatMessageType[] = [];
  private deepResearchResult: deepResearchResultType | undefined = undefined;

  constructor(config: StreamChatConfig) {
    this.config = config;
  }

  async execute(): Promise<void> {
    if (this.config.inputValue === "" && this.config.isResume === undefined)
      return;

    await this.handleSession();

    this.setupAbortController();

    if (this.config.callingMode === "direct") {
      this.initializeMessages();
    } else if (this.config.callingMode === "resume") {
      this.resumeMessages();
    } else {
      this.reInitializeMessages();
    }

    await this.executeStreamRequest();
  }

  // 处理session逻辑，没有session创建session
  private async handleSession(): Promise<void> {
    this.sessionId = this.config.sessionId || "";

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
        const res = await apiClient.post("/conversations/create_session", {
          chat_session: chat_session,
        });

        if (res.success) {
          this.config.addChatSession(chat_session);
          this.config.setCurrentSessionId(chat_session.id);
        }
      } catch (error) {
        console.error("Failed to create session:", error);
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
      role: "user",
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
        role: "assistant",
        content: "",
        mode: this.config.mode,
      } as ChatMessageType,
    ];

    this.config.setCurrentMessages(
      JSON.parse(JSON.stringify(this.initialUpdateMessages))
    );
    this.config.setShouldAutoScroll(true);
  }

  // recall和reEditCall模式下初始化user和ai消息
  private reInitializeMessages(): void {
    const len = this.config.currentMessages.length;

    if (this.config.callingMode === "recall") {
      this.initialUpdateMessages = [
        ...this.config.currentMessages.slice(0, len - 1),
        {
          ...this.config.currentMessages[len - 1],
          content: "",
          mode: this.config.mode,
          deepResearchResult: undefined,
          researchStatus: "failed",
        },
      ];
    } else if (this.config.callingMode === "reEditCall") {
      this.initialUpdateMessages = [
        ...this.config.currentMessages.slice(0, len - 2),
        {
          ...this.config.currentMessages[len - 2],
          content: this.config.inputValue,
          mode: this.config.mode,
          deepResearchResult: undefined,
          researchStatus: "failed",
        },
        {
          ...this.config.currentMessages[len - 1],
          content: "",
          mode: this.config.mode,
          deepResearchResult: undefined,
          researchStatus: "failed",
        },
      ];
    }

    this.assistantMessageId = len;
    this.config.setCurrentMessages(
      JSON.parse(JSON.stringify(this.initialUpdateMessages))
    );
    this.config.setShouldAutoScroll(true);
  }

  // 研究过程决策恢复
  private resumeMessages(): void {
    const len = this.config.currentMessages.length;
    this.initialUpdateMessages = this.config.currentMessages;
    this.assistantMessageId = len;
    this.accumulatedContent = this.config.currentMessages[len - 1]
      .content as string;
  }

  // 执行SSE
  private async executeStreamRequest(): Promise<void> {
    try {
      const requestBody: Record<string, any> = {
        input: this.config.inputValue,
        sessionId: this.sessionId,
        hasFiles: this.config.hasFiles,
        uploadedFiles: this.config.uploadedFiles || [],
        deepResearchId: `dr-${this.sessionId}-${this.assistantMessageId}`,
        isResume: this.config.isResume,
      };

      requestBody.agentType = this.config.agentType;

      const response = await fetch(this.config.apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: this.abortController!.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Response body is not readable");
      }

      await this.processStream(reader);
    } catch (error) {
      await this.handleError(error);
    } finally {
      await this.cleanup();
    }
  }

  private async processStream(
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<void> {
    await this.processStreamV2(reader);
  }

  private async processStreamV2(
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<void> {
    const consumer = new EventConsumer();

    // 注册 LLM 流式文本处理器
    consumer.registerHandler(
      AgentEventType.LLM_STREAM,
      createLlmStreamHandler((text) => {
        this.accumulatedContent += text;
        this.updateMessages();
      }),
    );

    // 注册状态更新处理器（用于 DeepResearch）
    if (this.config.onStreamData) {
      consumer.registerHandler(
        AgentEventType.STATE_UPDATE,
        createStateUpdateHandler({
          onSimpleAnalysis: (data) => {
            const newContent = this.config.onStreamData?.({
              type: "start_analyse",
              payload: data,
            }, this.accumulatedContent);
            if (newContent !== undefined) {
              this.accumulatedContent = newContent;
              this.updateMessages();
            }
          },
          onTasksInitial: (data) => {
            const newContent = this.config.onStreamData?.({
              type: "tasks_initial",
              payload: data,
            }, this.accumulatedContent);
            if (newContent !== undefined) {
              this.accumulatedContent = newContent;
              this.updateMessages();
            }
          },
          onTaskUpdate: (data) => {
            const newContent = this.config.onStreamData?.({
              type: "task_update",
              payload: data,
            }, this.accumulatedContent);
            if (newContent !== undefined) {
              this.accumulatedContent = newContent;
              this.updateMessages();
            }
          },
          onReport: (data) => {
            const newContent = this.config.onStreamData?.({
              type: "report",
              payload: data,
            }, this.accumulatedContent);
            if (newContent !== undefined) {
              this.accumulatedContent = newContent;
              this.updateMessages();
            }
          },
        }),
      );

      // 注册任务进度处理器
      consumer.registerHandler(
        AgentEventType.TASK_PROGRESS,
        createTaskProgressHandler((payload) => {
          const newContent = this.config.onStreamData?.({
            type: "task_update",
            payload: payload,
          }, this.accumulatedContent);
          if (newContent !== undefined) {
            this.accumulatedContent = newContent;
            this.updateMessages();
          }
        }),
      );

      // 注册人工中断处理器
      consumer.registerHandler(
        AgentEventType.HUMAN_INTERRUPT,
        createHumanInterruptHandler((payload) => {
          const newContent = this.config.onStreamData?.({
            type: "interrupt",
            payload: payload,
          }, this.accumulatedContent);
          if (newContent !== undefined) {
            this.accumulatedContent = newContent;
            this.updateMessages();
          }
        }),
      );
    }

    // 注册生命周期处理器
    consumer.registerHandler(
      AgentEventType.LIFECYCLE,
      createLifecycleHandler({
        onDone: () => {
          console.log("Stream completed");
        },
      }),
    );

    // 注册错误处理器
    consumer.registerHandler(
      AgentEventType.ERROR,
      createErrorHandler((payload) => {
        console.error("Stream error:", payload.errorMessage);
      }),
    );

    // 使用 EventConsumer 消费 SSE 流
    await consumer.consumeSSEStream(reader);
  }

  // 更新UI
  private updateMessages(): void {
    const updateMessages = this.initialUpdateMessages.map((msg) =>
      msg.id === this.assistantMessageId
        ? { ...msg, content: this.accumulatedContent }
        : msg
    );
    this.config.setCurrentMessages(JSON.parse(JSON.stringify(updateMessages)));
  }

  //处理中断和错误
  private async handleError(error: any): Promise<void> {
    if (error.name === "AbortError") {
      console.log("Chat was Interrupted by user");
      if (this.config.onStreamComplete) {
        //自定义结束处理
        this.config.onStreamComplete({
          finalContent: this.accumulatedContent,
          sessionId: this.sessionId,
          messageId: this.assistantMessageId,
        });
      }
    } else {
      console.error("Stream error:", error);

      if (this.config.onStreamError) {
        //自定义错误处理
        this.config.onStreamError(error);
      } else {
        // 默认错误处理
        const updateMessages = this.initialUpdateMessages.map((msg) =>
          msg.id === this.assistantMessageId
            ? { ...msg, content: "出错了，哎嘿。", researchStatus: "failed" }
            : msg
        );
        this.accumulatedContent = "出错了，哎嘿。";
        this.config.setCurrentMessages(
          JSON.parse(JSON.stringify(updateMessages))
        );
      }
    }
  }

  private async cleanup(): Promise<void> {
    this.config.setIsChating(false);
    this.config.setAbortController(null);

    if (this.accumulatedContent) {
      if (this.abortController?.signal.aborted)
        this.accumulatedContent += "\n 消息已被停止。";
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
    const newUserMessage = this.initialUpdateMessages.findLast(
      (msg) => msg.role === "user"
    );
    const newAssistantMessage: ChatMessageType = {
      id: this.assistantMessageId,
      sessionId: this.sessionId,
      role: "assistant",
      content: this.accumulatedContent,
      mode: this.config.mode,
    };

    if (
      this.config.mode === "deepResearch" &&
      this.config.getDeepResearchResult
      // &&this.config.getDeepResearchStatus?.() === "end"
    ) {
      this.deepResearchResult = this.config.getDeepResearchResult(
        this.sessionId,
        this.assistantMessageId
      );
      if (this.deepResearchResult) {
        newAssistantMessage.deepResearchResult = this.deepResearchResult;
        newAssistantMessage.researchStatus = "finished";
        const updateMessages = this.initialUpdateMessages.map((msg) =>
          msg.id === this.assistantMessageId ? newAssistantMessage : msg
        );
        this.config.setCurrentMessages(
          JSON.parse(JSON.stringify(updateMessages))
        );
      }
    }
    // console.log("deepresearch:", this.deepResearchResult);

    try {
      if (this.config.callingMode === "direct") {
        await apiClient.post("/conversations/add_messages", {
          chat_messages: [newUserMessage, newAssistantMessage],
          hasFiles: this.config.hasFiles,
          uploadedFiles: this.config.uploadedFiles || [],
        });
      } else {
        await apiClient.post("/conversations/update_messages", {
          chat_messages: [newUserMessage, newAssistantMessage],
          hasFiles: this.config.hasFiles,
          uploadedFiles: this.config.uploadedFiles || [],
        });
      }
    } catch (error) {
      console.error("Failed to save messages:", error);
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
