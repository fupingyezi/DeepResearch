'use client';

import Image from 'next/image';

import { chatWithAgent } from '@/utils/chat';
import { useConversationStore } from '@/store';
import { useState, useRef, type KeyboardEvent } from 'react';

/**
 * 中断决策（human-in-the-loop）交互组件。
 *
 * 由 MessageTimeline 在 status === 'interrupt' 时挂载本组件。
 *
 * 支持 ask_clarification 等 HITL 工具的「开放式问答」场景：
 *   1. 显示 agent 抛出的 question 与可选的 details 补充说明
 *   2. 用户在输入框中填写回答后提交（支持回车键）
 *   3. 决策结果通过 chatWithAgent + operation='resume' 续接同一会话，
 *      后端 checkpointer 会自动取出上一轮 messages（含 plan/clarification）。
 */
export const HumanDecision: React.FC<{
  question?: string;
  details?: unknown;
}> = ({ question, details }) => {
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** 输入法组合状态：防止 IME 编码期间回车误提交 */
  const isComposingRef = useRef(false);

  // 高度自适应 textarea
  const handleInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
  };

  const handleSubmit = async () => {
    const text = answer.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    await chatWithAgent({
      inputValue: text,
      operation: 'resume',
      resumeDecision: text,
      ...useConversationStore.getState(),
    });
    setSubmitting(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || isComposingRef.current) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  /** 安全渲染 details：string / object 均可展示 */
  const renderDetails = (): string | null => {
    if (details == null) return null;
    if (typeof details === 'string') return details;
    try {
      return JSON.stringify(details, null, 2);
    } catch {
      return String(details);
    }
  };

  const detailText = renderDetails();

  return (
    <div className="flex flex-col gap-2">
      {/* details 补充说明 */}
      {detailText && (
        <div className="rounded-xl border border-gray-100 bg-gray-50/70 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-gray-600">
          {detailText}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
        className="flex items-end gap-2"
      >
        <textarea
          ref={textareaRef}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            setTimeout(() => {
              isComposingRef.current = false;
            }, 0);
          }}
          placeholder={question ? '请输入你的回答…' : '请确认…'}
          rows={1}
          disabled={submitting}
          autoFocus
          className="scrollbar-hide flex-1 resize-none overflow-y-auto rounded-xl border border-[#e5e7eb] px-3 py-2.5 text-sm text-gray-800 transition-all placeholder:text-gray-300 focus:border-teal-400 focus:shadow-[0_0_0_3px_rgba(14,165,164,0.10)] focus:outline-none"
          style={{ minHeight: '40px', maxHeight: '100px', height: 'auto' }}
        />

        <button
          type="submit"
          disabled={!answer.trim() || submitting}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-teal-500 to-teal-600 shadow-[0_2px_8px_rgba(14,165,164,0.30)] transition-all hover:shadow-[0_4px_12px_rgba(14,165,164,0.45)] active:scale-95 disabled:opacity-40 disabled:hover:shadow-[0_2px_8px_rgba(14,165,164,0.30)]"
        >
          {submitting ? (
            <div className="h-3 w-3 rounded-xs bg-white/80" />
          ) : (
            <Image src="/send.svg" alt="发送" width={18} height={18} />
          )}
        </button>
      </form>
    </div>
  );
};
