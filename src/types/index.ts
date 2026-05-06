// 组件传参相关
import type {
  ChatLayoutProps,
  ChatMessageBubbleProps,
  ChatInputProps,
  ChatMessagesProps,
  ChatWindowProps,
  FileItemsProps,
  MessageToolType,
  SupportDownloadFileType,
  MessageToolBarProps,
} from "./webview";

// 数据定义相关
import type {
  ChatMessageType,
  ChatSessionType,
  taskType,
  searchResultItem,
  deepResearchResultType,
  fileMetadataType,
  UploadedFileStatus,
  UploadedFile,
} from "./chat-info-define";

//函数参数相关
import type {
  chatWithChatAssistantProps,
  chatWithDeepResearchProps,
  reChatWithAssistantProps,
} from "./chat-utils-params";

export {
  FileItemsProps,
  ChatLayoutProps,
  ChatMessageBubbleProps,
  ChatInputProps,
  ChatMessagesProps,
  ChatWindowProps,
  MessageToolType,
  SupportDownloadFileType,
  MessageToolBarProps,
};

export {
  ChatMessageType,
  ChatSessionType,
  taskType,
  searchResultItem,
  deepResearchResultType,
  fileMetadataType,
  UploadedFileStatus,
  UploadedFile,
};

export {
  chatWithChatAssistantProps,
  chatWithDeepResearchProps,
  reChatWithAssistantProps,
};

// 统一事件协议类型（v2 事件驱动架构）
export {
  AgentEventType,
  type AgentEvent,
  type AgentEventStream,
  type AgentEventMetadata,
  type LlmStreamPayload,
  type LlmCompletePayload,
  type ToolCallStartPayload,
  type ToolCallResultPayload,
  type StateUpdatePayload,
  type HumanInterruptPayload,
  type HumanResumePayload,
  type ErrorPayload,
  type LifecyclePayload,
  type NodeEnterPayload,
  type NodeExitPayload,
  type TaskProgressPayload,
  type LlmStreamEvent,
  type LlmCompleteEvent,
  type ToolCallStartEvent,
  type ToolCallResultEvent,
  type StateUpdateEvent,
  type HumanInterruptEvent,
  type HumanResumeEvent,
  type ErrorEvent,
  type LifecycleEvent,
  type NodeEnterEvent,
  type NodeExitEvent,
  type TaskProgressEvent,
  type SubAgentDispatchPayload,
  type SubAgentDispatchEvent,
  type HarnessLifecyclePayload,
  type HarnessLifecycleEvent,
  createAgentEvent,
} from "./agent-event";
