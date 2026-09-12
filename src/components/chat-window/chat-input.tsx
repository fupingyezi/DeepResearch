import React, { useState, useRef } from 'react';
import Image from 'next/image';
import { LoadingOutlined } from '@ant-design/icons';

import FileItem from '../files/file-items';

import { ChatInputProps } from '@/types';
import { useConversationStore } from '@/store';
import { useFileUpload, useTextareaAutoHeight } from '@/hooks';
import { enhancePrompt } from '@/utils/prompt';
import { cancelRunOnServer } from '@/utils/chat/cancel-run';

/** 增强提示词图标：主体四角星 + 右上角小四角星（fill 跟随 currentColor 变色） */
const EnhanceStarIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M11.5 9.5 9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5z" />
    <path d="m19 9 1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9z" />
  </svg>
);

/** 撤销图标：钩形回退箭头（左向箭头 + 尾部下弯回勾，区别于"重试"式环形箭头） */
const UndoHookIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </svg>
);

const ChatInput: React.FC<ChatInputProps> = ({
  placeholder,
  onSend,
  disabled = false,
  className,
}) => {
  const isChating = useConversationStore((s) => s.isChating);
  const currentSessionId = useConversationStore((s) => s.currentSessionId);
  const abortCurrentChat = useConversationStore((s) => s.abortCurrentChat);
  const [inputValue, setInputValue] = useState('');
  // 提示词增强：null = 当前文本未被增强（星星态）；非 null = 增强后的原文快照（撤销态）
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceOriginal, setEnhanceOriginal] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const { localUploadedFiles, handleFiles, removeFile, clearFiles, getFileIcon } = useFileUpload();

  // 高度自适应：把读 scrollHeight + 写 height 收敛到一次 layout 帧内
  useTextareaAutoHeight(textareaRef, inputValue, 100);

  // 停止：两件事都要做。① abort 本地 fetch 让 UI 立刻停住；② 通知服务端取消在跑的 run
  // —— 服务端 run 是 fire-and-forget，只断 SSE 的话它会继续生成并把完整回答落库。
  const handleStop = () => {
    abortCurrentChat();
    const sid = String(currentSessionId);
    if (sid) void cancelRunOnServer(sid);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // 停止优先于一切守卫：正在跑就必须能停下来。此前 disabled 分支在前，而聊天中
    // disabled 恒为 true（chat-window 传的是 isChating || guardDisabled），于是「停止」
    // 成了一个点了完全没反应的死按钮 —— 不 abort、运行态不变、按钮也不变回发送。
    if (isChating) {
      handleStop();
      return;
    }

    // 统一前置守卫：disabled 状态下任何发送路径都不应产生副作用
    if (disabled) return;
    if (isComposingRef.current) return;

    if (!localUploadedFiles.every((file) => file.parsedStatus === 'success')) {
      return;
    }

    if (inputValue.trim() && onSend) {
      const hasFiles = localUploadedFiles.length > 0;
      onSend(inputValue.trim(), { hasFiles });
      setInputValue('');
      setEnhanceOriginal(null);
      clearFiles();
    }
  };

  const canUndo = enhanceOriginal !== null;
  const canEnhance =
    !disabled && !isChating && !enhancing && !canUndo && inputValue.trim().length > 0;

  const handleEnhanceClick = async () => {
    // 撤销态：点击恢复增强前的原文，回到星星态
    if (canUndo) {
      setInputValue(enhanceOriginal);
      setEnhanceOriginal(null);
      return;
    }
    if (!canEnhance) return;
    setEnhancing(true);
    try {
      const enhanced = await enhancePrompt(inputValue);
      if (enhanced.trim()) {
        setEnhanceOriginal(inputValue);
        setInputValue(enhanced);
      }
    } catch (e) {
      // 失败保持输入框原内容，仅记录日志（输入框内无错误提示位）
      console.error('[chat-input] enhance prompt failed:', e);
    } finally {
      setEnhancing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isChating) return;
    if (e.nativeEvent.isComposing || isComposingRef.current) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleUploadClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={`flex flex-col gap-2 rounded-3xl border border-[#e5e7eb] bg-white p-3 shadow-[0_2px_8px_rgba(16,24,40,0.06)] transition-all focus-within:border-teal-400 focus-within:shadow-[0_4px_16px_rgba(14,165,164,0.12)] ${className || ''}`}
    >
      <div className="grid w-full grid-cols-4 gap-2">
        {localUploadedFiles.length !== 0 &&
          localUploadedFiles.map((uploadFile) => (
            <FileItem
              id={uploadFile.id}
              key={uploadFile.id}
              fileName={uploadFile.file.name}
              parsedStatus={uploadFile.parsedStatus}
              sizeBytes={uploadFile.sizeBytes}
              ImgComponent={getFileIcon(uploadFile.file.type, uploadFile.file.name)}
              removeFile={removeFile}
              canClose={true}
            />
          ))}
      </div>
      <textarea
        ref={textareaRef}
        value={inputValue}
        onChange={(e) => {
          setInputValue(e.target.value);
          // 用户手动编辑后撤销快照失效（增强后未点撤销又改过 → 不能再撤销）
          setEnhanceOriginal(null);
        }}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={() => {
          setTimeout(() => {
            isComposingRef.current = false;
          }, 0);
        }}
        placeholder={placeholder}
        rows={1}
        className="scrollbar-hide w-full resize-none overflow-y-auto rounded-md border border-transparent px-3 py-2 focus:outline-none"
        style={{
          minHeight: '40px',
          maxHeight: '100px',
          height: 'auto',
        }}
      />
      <div className="flex w-full flex-wrap items-center justify-between gap-2 px-2">
        <div className="flex items-center gap-2">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            multiple
            accept=".pdf,.docx,.md,.txt,.png,.jpg,.jpeg,.webp,.gif"
            className="hidden"
          />
          <Image
            src="/add.svg"
            alt="添加附件"
            width={30}
            height={30}
            className="h-8 w-10 rounded-3xl p-2 hover:cursor-pointer hover:bg-[#e7e7e7]"
            onClick={() => handleUploadClick()}
          />
        </div>

        <div className="flex items-center gap-1">
          {/* 提示词增强：星星（待增强）→ 加载中 → 撤销（恢复原文） */}
          <button
            type="button"
            onClick={handleEnhanceClick}
            disabled={!canUndo && !canEnhance}
            title={canUndo ? '撤销增强，恢复原提示词' : '增强提示词'}
            className={`flex h-10 w-10 items-center justify-center rounded-full transition-all hover:cursor-pointer active:scale-95 ${
              canUndo
                ? 'text-teal-600 hover:bg-[#e6f7f4]'
                : 'text-[#9ca3af] hover:bg-[#f3f4f6] hover:text-teal-600'
            } disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[#9ca3af] disabled:active:scale-100`}
          >
            {enhancing ? (
              <LoadingOutlined spin className="text-[18px]" />
            ) : canUndo ? (
              <UndoHookIcon className="h-[18px] w-[18px]" />
            ) : (
              <EnhanceStarIcon className="h-[18px] w-[18px]" />
            )}
          </button>

          <button
            type="submit"
            disabled={disabled && !isChating}
            className={`flex h-10 w-10 items-center justify-center rounded-full bg-linear-to-br from-teal-500 to-teal-600 shadow-[0_2px_8px_rgba(14,165,164,0.3)] transition-all hover:cursor-pointer hover:shadow-[0_4px_12px_rgba(14,165,164,0.45)] active:scale-95 disabled:cursor-not-allowed disabled:from-gray-300 disabled:to-gray-400 disabled:shadow-none disabled:hover:shadow-none disabled:active:scale-100`}
          >
            {isChating ? (
              <div className="flex h-6 w-6 items-center justify-center">
                <div className="h-3.5 w-3.5 rounded-xs bg-white"></div>
              </div>
            ) : (
              <Image src="/send.svg" alt="发送" width={22} height={22} />
            )}
          </button>
        </div>
      </div>
    </form>
  );
};

export default ChatInput;
