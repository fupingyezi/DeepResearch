'use client';

import { ChatLayoutProps, ChatWindowProps } from '@/types';
import React, { useCallback, useEffect } from 'react';
import ChatMessage from './chat-message';
import ChatInput from './chat-input';
import { useConversationStore, useFileUploadStore, useModelStore } from '@/store';
import { useModelConfigStatus } from '@/hooks';
import { chatWithAgent } from '@/utils/chat';
import type { ModelPresetName } from '@/config/models';

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
  const { model, setModel } = useModelStore();
  // 模型配置状态：决定是否可发送 + 引导文案；selectedModel 以服务端为准。
  const { hasUsableKey, selectedModel, loading } = useModelConfigStatus();

  // 把服务端落库的 selectedModel 同步到本地 store，保证发送时携带正确模型。
  useEffect(() => {
    if (selectedModel && selectedModel !== model) {
      setModel(selectedModel as ModelPresetName);
    }
  }, [selectedModel, model, setModel]);

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
        model: (selectedModel as ModelPresetName) ?? model,
        uploadedFiles: opts?.hasFiles ? uploadedFiles : undefined,
        ...conversationStore,
      });
      if (opts?.hasFiles) {
        clearUploadedFiles();
      }
    },
    [uploadedFiles, clearUploadedFiles, model, selectedModel],
  );

  // 未配置任何可用 Key 时禁用输入并展示引导文案；加载中也先禁用，避免空跑请求。
  const guardDisabled = loading || !hasUsableKey;
  const effectivePlaceholder = guardDisabled
    ? '请先在「设置 - 模型管理」中选择模型并填写 API Key'
    : placeholder;

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
          placeholder={effectivePlaceholder}
          onSend={handleSendMessage}
          disabled={isChating || guardDisabled}
        />
      }
    />
  );
};

export default ChatWindow;
