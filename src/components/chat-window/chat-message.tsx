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

  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const scrollToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    // 进入窗口期 → 即将派发的 onScroll 事件不应改变 shouldAutoScroll。
    programmaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current) {
      clearTimeout(programmaticScrollTimerRef.current);
    }

    container.scrollTop = container.scrollHeight;

    // 给浏览器一帧机会派完同步排队的 scroll 事件后再解除窗口。
    programmaticScrollTimerRef.current = setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollTimerRef.current = null;
    }, 80);
  }, []);

  const checkShouldAutoScroll = useCallback(
    (wheelEvent?: React.WheelEvent<HTMLDivElement>) => {
      if (!messagesContainerRef.current) return;
      // 程序化滚动期间不要回写 shouldAutoScroll，否则会和上面的 scrollToBottom 形成回路。
      if (programmaticScrollRef.current) return;

      const { scrollTop, scrollHeight, clientHeight } =
        messagesContainerRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;

      if (wheelEvent && wheelEvent.deltaY < 0 && !isAtBottom) {
        setShouldAutoScroll(false);
        return;
      }
      // 仅在用户事件（wheel）触发且确认到底时恢复，纯 scroll 事件不写。
      if (wheelEvent && isAtBottom) {
        setShouldAutoScroll(true);
      }
    },
    [setShouldAutoScroll]
  );

  // messages 引用变化（流式新增 / 编辑）时按需滚到底部。
  useEffect(() => {
    if (messagesContainerRef.current && shouldAutoScroll) {
      scrollToBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // 卸载时清掉定时器
  useEffect(() => {
    return () => {
      if (programmaticScrollTimerRef.current) {
        clearTimeout(programmaticScrollTimerRef.current);
      }
    };
  }, []);

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
          // 用 message.id 作为稳定 key，避免父组件每帧重建 messages 数组引用时
          // 列表项错位 remount，叠加 stream 高频 setCurrentMessages 会放大到无法收敛。
          key={msg.id ?? index}
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
