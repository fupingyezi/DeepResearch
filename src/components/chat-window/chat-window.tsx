"use client";

import { ChatLayoutProps, ChatWindowProps } from "@/types";
import React, { useCallback } from "react";
import ChatMessage from "./chat-message";
import ChatInput from "./chat-input";
import {
  useConversationStore,
  useFileUploadStore,
  useModelStore,
} from "@/store";
import { chatWithAgent } from "@/utils/chat";

const ChatLayout: React.FC<ChatLayoutProps> = ({ content, footer }) => {
  return (
    <div className="h-screen flex-1 flex flex-col pb-8">
      <div className="flex-1 overflow-y-auto scrollbar-hide p-4">{content}</div>
      <div className="shrink-0 bg-white">{footer}</div>
    </div>
  );
};

const ChatWindow: React.FC<ChatWindowProps> = ({
  emptyStateComponent,
  placeholder,
  className,
}) => {
  const isChating = useConversationStore((s) => s.isChating);
  const shouldAutoScroll = useConversationStore((s) => s.shouldAutoScroll);
  const currentMessages = useConversationStore((s) => s.currentMessages);
  const setShouldAutoScroll = useConversationStore((s) => s.setShouldAutoScroll);
  const { uploadedFiles, clearUploadedFiles } = useFileUploadStore();
  const { selectedModelKey } = useModelStore();

  const handleChangeScroll = useCallback(
    (next: boolean) => {
      setShouldAutoScroll(next);
    },
    [setShouldAutoScroll]
  );

  /**
   * 发送消息：对齐 deer-flow 2.0 单一入口。
   * - 不再有"联网搜索 / 深度研究"档位；
   * - 是否走深度研究由后端 lead-agent 自主判断；
   * - 前端只透传文本和附件状态。
   */
  const handleSendMessage = useCallback(
    async (
      inputValue: string,
      opts?: {
        hasFiles?: boolean;
      }
    ) => {
      const conversationStore = useConversationStore.getState();
      await chatWithAgent({
        inputValue,
        callingMode: "direct",
        modelKey: selectedModelKey,
        hasFiles: opts?.hasFiles,
        uploadedFiles: opts?.hasFiles ? uploadedFiles : undefined,
        ...conversationStore,
      });
      if (opts?.hasFiles) {
        clearUploadedFiles();
      }
    },
    [uploadedFiles, clearUploadedFiles, selectedModelKey]
  );

  return (
    <ChatLayout
      content={
        <ChatMessage
          messages={currentMessages}
          emptyStateComponent={emptyStateComponent}
          shouldAutoScroll={shouldAutoScroll}
          setShouldAutoScroll={handleChangeScroll}
          className={className}
        />
      }
      footer={
        <ChatInput
          placeholder={placeholder}
          onSend={handleSendMessage}
          disabled={isChating}
        />
      }
    />
  );
};

export default ChatWindow;
