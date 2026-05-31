'use client';

import { ChatLayoutProps, ChatWindowProps } from '@/types';
import React, { useCallback } from 'react';
import ChatMessage from './chat-message';
import ChatInput from './chat-input';
import { useConversationStore, useFileUploadStore, useModelStore } from '@/store';
import { chatWithAgent } from '@/utils/chat';

const ChatLayout: React.FC<ChatLayoutProps> = ({ content, footer }) => {
  return (
    <div className="flex h-screen flex-1 flex-col pb-6">
      <div className="scrollbar-hide flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto h-full w-full max-w-[960px]">{content}</div>
      </div>
      <div className="shrink-0 bg-transparent px-6">
        <div className="mx-auto w-full max-w-[960px]">{footer}</div>
      </div>
    </div>
  );
};

const ChatWindow: React.FC<ChatWindowProps> = ({ emptyStateComponent, placeholder, className }) => {
  const isChating = useConversationStore((s) => s.isChating);
  const shouldAutoScroll = useConversationStore((s) => s.shouldAutoScroll);
  const currentMessages = useConversationStore((s) => s.currentMessages);
  const setShouldAutoScroll = useConversationStore((s) => s.setShouldAutoScroll);
  const { uploadedFiles, clearUploadedFiles } = useFileUploadStore();
  const { model } = useModelStore();

  const handleChangeScroll = useCallback(
    (next: boolean) => {
      setShouldAutoScroll(next);
    },
    [setShouldAutoScroll],
  );

  const handleSendMessage = useCallback(
    async (
      inputValue: string,
      opts?: {
        hasFiles?: boolean;
      },
    ) => {
      const conversationStore = useConversationStore.getState();
      await chatWithAgent({
        inputValue,
        model,
        uploadedFiles: opts?.hasFiles ? uploadedFiles : undefined,
        ...conversationStore,
      });
      if (opts?.hasFiles) {
        clearUploadedFiles();
      }
    },
    [uploadedFiles, clearUploadedFiles, model],
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
        <ChatInput placeholder={placeholder} onSend={handleSendMessage} disabled={isChating} />
      }
    />
  );
};

export default ChatWindow;
