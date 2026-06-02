import React, { useState, useRef } from 'react';

import ChatMessageBubble from './chat-message-bubble';

import { ChatMessagesProps } from '@/types';
import { useAutoScrollToBottom } from '@/hooks';

const ChatMessage: React.FC<ChatMessagesProps> = ({
  messages,
  emptyStateComponent,
  shouldAutoScroll,
  setShouldAutoScroll,
  className,
}) => {
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [selectDownloadId, setSelectDownLoadId] = useState<string>('');

  const { onScroll, onWheel, onTouchMove } = useAutoScrollToBottom({
    containerRef: messagesContainerRef,
    enabled: shouldAutoScroll,
    setEnabled: setShouldAutoScroll,
    trigger: messages,
  });

  if (!messages || messages.length === 0) {
    return (
      <div
        className={`flex h-[70%] w-full flex-col items-center justify-center gap-4 text-center ${className || ''} `}
      >
        <div className="bg-gradient-to-br from-teal-500 via-sky-500 to-teal-600 bg-clip-text font-serif text-6xl font-bold text-transparent">
          {emptyStateComponent}
        </div>
        <p className="text-2xl text-gray-400" style={{ fontFamily: '楷体' }}>
          阅尽好花千万树，愿君记取此一枝。
        </p>
      </div>
    );
  }

  return (
    <div
      className={`space-y-4 ${className || ''} scrollbar-hide h-full overflow-y-scroll`}
      ref={messagesContainerRef}
      onWheel={onWheel}
      onScroll={onScroll}
      onTouchMove={onTouchMove}
    >
      {messages.map((message, index) => (
        <ChatMessageBubble
          key={message.id ?? index}
          message={message}
          isLastAIMessage={message.role === 'assistant' && index === messages.length - 1}
          isLastHumanMessage={message.role === 'user' && index === messages.length - 2}
          selectDownloadId={selectDownloadId}
          setSelectDownloadId={setSelectDownLoadId}
        />
      ))}
    </div>
  );
};

export default ChatMessage;
