import React, { ReactNode } from "react";
import { ChatMessageType } from "./chat-info-define";
import { UploadedFile } from "./chat-info-define";

export interface ChatMessageBubbleProps {
  message: ChatMessageType;
  isLastAIMessage: boolean;
  isLastHumanMessage: boolean;
  selectDownloadId: number;
  setSelectDownloadId: (selectDownloadId: number) => void;
}

export interface ChatMessagesProps {
  messages: ChatMessageType[];
  emptyStateComponent: ReactNode;
  shouldAutoScroll: boolean;
  setShouldAutoScroll: (shouldAutoScroll: boolean) => void;
  className?: string;
}

export interface ChatInputSendOptions {
  hasFiles?: boolean;
  /**
   * @deprecated 自 deer-flow 2.0 重构起，前端不再有"深度研究"档位；
   * 是否进入深度研究流程由后端 lead-agent 自主判断。该字段保留仅为
   * 兼容旧调用点，新代码不应使用。
   */
  enableDeepResearch?: boolean;
  /**
   * @deprecated 自 deer-flow 2.0 重构起，前端不再有"联网搜索"档位；
   * 是否调用 search_web_tool 由 lead-agent 自主决定。
   */
  enableSearch?: boolean;
}

export interface ChatInputProps {
  placeholder?: string;
  onSend?: (message: string, opts?: ChatInputSendOptions) => void;
  disabled?: boolean;
  className?: string;
}

export interface ChatWindowProps {
  emptyStateComponent: ReactNode;
  placeholder: string;
  className?: string;
}

export interface ChatLayoutProps {
  content: ReactNode;
  footer: ReactNode;
}

export interface FileItemsProps extends Omit<UploadedFile, "error" | "file"> {
  fileName: string;
  ImgComponent: React.ComponentType<{
    className?: string;
    style?: React.CSSProperties;
  }>;
  removeFile?: (id: string) => void;
  canClose?: boolean;
}

export type MessageToolType = "copy" | "recall" | "edit" | "download";
export type SupportDownloadFileType = "pdf" | "word" | "md" | "cancel";

export interface MessageToolBarProps {
  tools: MessageToolType[];
  supportDownloadFiles: SupportDownloadFileType[];
  handleToolAction?: (tool: MessageToolType) => void;
  handleDownloadFiles?: (fileType: SupportDownloadFileType) => void;
  className?: string;
}
