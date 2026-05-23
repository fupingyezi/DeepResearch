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
  // 精细订阅：只读 ChatWindow 真正用到的字段。
  // 之前 `useConversationStore()` / `useDeepResearchProcessStore()` 不传 selector，
  // 等价于订阅整个 store。SSE 高频更新 currentMessages 时，每个分片都会让
  // ChatWindow 重新拿到一个**全新的 store 对象引用**，再向下传播 props，
  // 叠加 useCallback deps 中的 store 整体引用，会让 onSend 引用每帧重建、
  // ChatInput 跟着重渲染——纯浪费，且会放大 commit 数量增加 React 撞
  // "Maximum update depth" 护栏的概率。
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
      // 直接 getState() 取最新快照而不是订阅，避免 store 高频变化让
      // handleSendMessage 引用每帧重建。store 内的状态在用户**点击发送**
      // 那一刻才被读到，因此一次性快照足够。
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

