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
   * 发送消息：合并版统一入口。
   * - 不再分三套链路（chat / search / deepResearch）；
   * - 是否启用搜索 / 深度研究由 ChatInput 通过 opts 传上来；
   * - 默认（两开关均关闭）= 普通对话。
   */
  const handleSendMessage = useCallback(
    async (
      inputValue: string,
      opts?: {
        hasFiles?: boolean;
        enableDeepResearch?: boolean;
        enableSearch?: boolean;
      }
    ) => {
      const conversationStore = useConversationStore.getState();
      await chatWithAgent({
        inputValue,
        callingMode: "direct",
        modelKey: selectedModelKey,
        hasFiles: opts?.hasFiles,
        uploadedFiles: opts?.hasFiles ? uploadedFiles : undefined,
        enableDeepResearch: !!opts?.enableDeepResearch,
        enableSearch: !!opts?.enableSearch,
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
