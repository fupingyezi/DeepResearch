"use client";

import { ChatLayoutProps, ChatWindowProps } from "@/types";
import React, { useCallback } from "react";
import ChatMessage from "./chat-message";
import ChatInput from "./chat-input";
import {
  useConversationStore,
  useDeepResearchProcessStore,
  useChatSelectStore,
  useFileUploadStore,
} from "@/store";
import {
  chatWithChatAssistant,
  chatWithDeepResearch,
  chatWithSearhAssistant,
} from "@/utils/chat";

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

  const handleChangeScroll = useCallback(
    (next: boolean) => {
      setShouldAutoScroll(next);
    },
    [setShouldAutoScroll]
  );

  const handleSendMessage = useCallback(
    async (inputValue: string, hasFiles?: boolean) => {
      const { selectedAgent } = useChatSelectStore.getState();
      const conversationStore = useConversationStore.getState();
      const deepResearchStore = useDeepResearchProcessStore.getState();
      if (selectedAgent === "chat") {
        await chatWithChatAssistant({
          inputValue,
          hasFiles,
          uploadedFiles,
          callingMode: "direct",
          ...conversationStore,
        });
        // 发送后清理文件状态
        if (hasFiles) {
          clearUploadedFiles();
        }
      } else if (selectedAgent === "search") {
        await chatWithSearhAssistant({
          inputValue,
          callingMode: "direct",
          ...conversationStore,
        });
      } else if (selectedAgent === "deepResearch") {
        deepResearchStore.resetState();
        await chatWithDeepResearch({
          inputValue,
          callingMode: "direct",
          ...conversationStore,
          ...deepResearchStore,
        });
      }
    },
    [uploadedFiles, clearUploadedFiles]
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

