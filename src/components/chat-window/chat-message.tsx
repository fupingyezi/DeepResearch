import ChatMessageBubble from "./chat-message-bubble";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { ChatMessagesProps } from "@/types";

const ChatMessage: React.FC<ChatMessagesProps> = ({
  messages,
  emptyStateComponent,
  shouldAutoScroll,
  setShouldAutoScroll,
  className,
}) => {
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [selectDownloadId, setSelectDownLoadId] = useState<number>(0);

  const scrollToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container || !shouldAutoScroll) return;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth",
    });
  }, [shouldAutoScroll]);

  const checkShouldAutoScroll = useCallback(
    (wheelEvent?: React.WheelEvent<HTMLDivElement>) => {
      if (!messagesContainerRef.current) return;

      const { scrollTop, scrollHeight, clientHeight } =
        messagesContainerRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;

      if (wheelEvent && wheelEvent.deltaY < 0 && !isAtBottom) {
        setShouldAutoScroll(false);
        return;
      }
      if (isAtBottom) {
        setShouldAutoScroll(true);
      }
    },
    [setShouldAutoScroll]
  );

  useEffect(() => {
    if (messagesContainerRef.current && shouldAutoScroll) {
      scrollToBottom();
    }
  }, [messages, scrollToBottom, shouldAutoScroll]);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, scrollToBottom]);

  if (!messages || messages.length === 0) {
    return (
      <div
        className={`w-full h-[70%] flex flex-col gap-2 justify-center text-center
          font-serif text-6xl text-wrap ${className || ""} `}
      >
        {emptyStateComponent}
        <p className="text-2xl" style={{ fontFamily: "楷体" }}>
          阅尽好花千万树，愿君记取此一枝。
        </p>
      </div>
    );
  }

  return (
    <div
      className={`space-y-4 ${
        className || ""
      } h-full overflow-y-scroll scrollbar-hide`}
      ref={messagesContainerRef}
      onScroll={() => checkShouldAutoScroll()}
      onWheel={(e) => checkShouldAutoScroll(e)}
    >
      {messages.map((msg, index) => (
        <ChatMessageBubble
          key={index}
          message={msg}
          isLastAIMessage={
            msg.role === "assistant" && index === messages.length - 1
          }
          isLastHumanMessage={
            msg.role === "user" && index === messages.length - 2
          }
          selectDownloadId={selectDownloadId}
          setSelectDownloadId={setSelectDownLoadId}
        />
      ))}
    </div>
  );
};

export default ChatMessage;
