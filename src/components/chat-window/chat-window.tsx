'use client';

import { ChatLayoutProps, ChatWindowProps } from '@/types';
import React, { useCallback, useEffect, useMemo } from 'react';
import ChatMessage from './chat-message';
import ChatInput from './chat-input';
import {
  useConversationStore,
  useFileUploadStore,
  useMemoryModeStore,
  useModelStore,
} from '@/store';
import { useModelConfigStatus } from '@/hooks';
import { useAgentEvent } from '@/events/context';
import type { ModelPresetName } from '@/config/models';

const ChatLayout: React.FC<ChatLayoutProps> = ({ header, content, footer }) => {
  return (
    <div className="flex h-screen flex-1 flex-col pb-6">
      {header}
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
  const chatSessions = useConversationStore((s) => s.chatSessions);
  const currentSessionId = useConversationStore((s) => s.currentSessionId);
  const { uploadedFiles, clearUploadedFiles } = useFileUploadStore();
  const { model, setModel } = useModelStore();
  // 模型配置状态：决定是否可发送 + 引导文案；selectedModel 以服务端为准。
  const { hasUsableKey, selectedModel, loading } = useModelConfigStatus();
  const { run } = useAgentEvent();

  // 把服务端落库的 selectedModel 同步到本地 store，保证发送时携带正确模型。
  useEffect(() => {
    if (selectedModel && selectedModel !== model) {
      setModel(selectedModel as ModelPresetName);
    }
  }, [selectedModel, model, setModel]);

  // 记忆注入模式：服务端（users.memory_mode）为准，拉取一次后发送时携带。
  const memoryMode = useMemoryModeStore((s) => s.mode);
  useEffect(() => {
    void useMemoryModeStore.getState().load();
  }, []);

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
      await run({
        inputValue,
        model: (selectedModel as ModelPresetName) ?? model,
        uploadedFiles: opts?.hasFiles ? uploadedFiles : undefined,
        memoryMode,
      });
      if (opts?.hasFiles) {
        clearUploadedFiles();
      }
    },
    [run, uploadedFiles, clearUploadedFiles, model, selectedModel, memoryMode],
  );

  // 顶栏对话摘要：当前会话的 title（autoTitle 经 END 事件的 titleUpdate 实时落回 chatSessions，
  // 这里直接读列表即可拿到最新值）；新建会话尚无标题时回落「新对话」。
  const currentSessionTitle = useMemo(() => {
    const session = chatSessions.find((s) => String(s.id) === String(currentSessionId));
    return session?.title || '新对话';
  }, [chatSessions, currentSessionId]);

  // 未配置任何可用 Key 时禁用输入并展示引导文案；加载中也先禁用，避免空跑请求。
  const guardDisabled = loading || !hasUsableKey;
  const effectivePlaceholder = guardDisabled
    ? '请先在「设置 - 模型管理」中选择模型并填写 API Key'
    : placeholder;

  return (
    <ChatLayout
      header={
        <div className="flex h-12 shrink-0 items-center border-b border-gray-200 bg-white px-6">
          <span className="min-w-0 truncate text-sm font-medium text-gray-700">
            {currentSessionTitle}
          </span>
        </div>
      }
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
