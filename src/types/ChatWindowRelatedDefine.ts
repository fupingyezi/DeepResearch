import { ReactNode } from "react";
import { UUIDTypes } from "uuid";
import { ChatMessageType } from "./conversation";

// export interface ChatMessageType {
//   id?: string;
//   role: string;
//   content: string | Record<string, string>;
// }

export interface chunkMessageType {
  type: "start" | "content" | "done" | "error";
  content?: string;
  role?: "user" | "assistant" | string;
  id?: string;
  done: boolean;
  error?: string;
}

export interface ChatMessageBubbleProps {
  message: ChatMessageType;
  isLastAIMessage: boolean;
  isLastHumanMessage: boolean;
}

export interface ChatMessagesProps {
  messages: ChatMessageType[];
  emptyStateComponent: ReactNode;
  shouldAutoScroll: boolean;
  setShouldAutoScroll: (shouldAutoScroll: boolean) => void;
  className?: string;
}

export interface ChatInputProps {
  placeholder?: string;
  onSend?: (message: string) => void;
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
