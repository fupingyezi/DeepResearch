import React, { useState, useRef } from 'react';
import Image from 'next/image';

import FileItem from '../files/file-items';
import ModelSelector from '../model-selector/model-selector';

import { ChatInputProps } from '@/types';
import { useConversationStore } from '@/store';
import { useFileUpload, useTextareaAutoHeight } from '@/hooks';

const ChatInput: React.FC<ChatInputProps> = ({
  placeholder,
  onSend,
  disabled = false,
  className,
}) => {
  const isChating = useConversationStore((s) => s.isChating);
  const currentAbortController = useConversationStore((s) => s.currentAbortController);
  const abortCurrentChat = useConversationStore((s) => s.abortCurrentChat);
  const [inputValue, setInputValue] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const { localUploadedFiles, handleFiles, removeFile, clearFiles, getFileIcon } = useFileUpload();

  // 高度自适应：把读 scrollHeight + 写 height 收敛到一次 layout 帧内
  useTextareaAutoHeight(textareaRef, inputValue, 100);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // 统一前置守卫：disabled 状态下任何路径都不应产生副作用
    if (disabled) return;
    if (isComposingRef.current) return;

    if (!localUploadedFiles.every((file) => file.parsedStatus === 'success')) {
      return;
    }

    if (isChating) {
      if (currentAbortController) {
        abortCurrentChat();
      }
      return;
    }

    if (inputValue.trim() && onSend) {
      const hasFiles = localUploadedFiles.length > 0;
      onSend(inputValue.trim(), { hasFiles });
      setInputValue('');
      clearFiles();
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
        onChange={(e) => setInputValue(e.target.value)}
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
            accept=".pdf,.docx,.md,.txt"
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
          <ModelSelector showLabel={false} />
        </div>

        <button
          type="submit"
          className={`flex h-10 w-10 items-center justify-center rounded-full bg-linear-to-br from-teal-500 to-teal-600 shadow-[0_2px_8px_rgba(14,165,164,0.3)] transition-all hover:cursor-pointer hover:shadow-[0_4px_12px_rgba(14,165,164,0.45)] active:scale-95`}
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
    </form>
  );
};

export default ChatInput;
