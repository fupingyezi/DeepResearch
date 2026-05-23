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

  // 标记"程序化滚动"窗口期：scrollTo 触发的原生 scroll 事件在窗口期内必须被忽略，
  // 否则会形成 scrollTo → onScroll → setShouldAutoScroll → re-render → effect → scrollTo …
  // 的循环，叠加 SSE 高频 setCurrentMessages 时会撞 React 50 层 setState 阈值，
  // 抛出 "Maximum update depth exceeded"（堆栈贴在 setCurrentMessages 上，看起来像 SSE 出错）。
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

    // 直接赋值（瞬时滚动）比 behavior:"smooth" 更安全：smooth 动画过程中 scrollTop
    // 是渐变的，会持续派发 scroll 事件，窗口期需要更长，且边界像素抖动会让
    // checkShouldAutoScroll 在 true/false 间反复切换，仍可能进入回路。
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

      // 仅在用户向上滚动且离底时关闭自动滚动。其它情况不再主动写 true，
      // 避免与 store 中"值未变才不写入"的兜底冲突。shouldAutoScroll 默认为 true，
      // 用户主动向上滚后变 false，需要再次到底（自然滚动）时由下面的分支恢复。
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
  // deps 只放 messages：scrollToBottom 现在不依赖 shouldAutoScroll，引用稳定。
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
