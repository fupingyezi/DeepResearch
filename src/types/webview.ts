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
