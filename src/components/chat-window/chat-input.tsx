import React, { useState, useRef, useLayoutEffect } from "react";
import { useFileUpload } from "@/utils/hooks";
import Image from "next/image";
import FileItem from "../files/file-items";
import { ChatInputProps } from "@/types";
import { useConversationStore } from "@/store";
import ModelSelector from "../model-selector/model-selector";

const ChatInput: React.FC<ChatInputProps> = ({
  placeholder,
  onSend,
  disabled = false,
  className,
}) => {
  const isChating = useConversationStore((s) => s.isChating);
  const currentAbortController = useConversationStore(
    (s) => s.currentAbortController
  );
  const abortCurrentChat = useConversationStore((s) => s.abortCurrentChat);
  const [inputValue, setInputValue] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const {
    localUploadedFiles,
    handleFiles,
    removeFile,
    clearFiles,
    getFileIcon,
  } = useFileUpload();

  // 高度自适应：把读 scrollHeight + 写 height 收敛到一次 layout 帧内，
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 100) + "px";
  }, [inputValue]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // 统一前置守卫：disabled 状态下任何路径都不应产生副作用
    if (disabled) return;
    if (isComposingRef.current) return;

    if (!localUploadedFiles.every((file) => file.parsedStatus === "success")) {
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
      setInputValue("");
      clearFiles();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isChating) return;
    if (
      e.nativeEvent.isComposing ||
      isComposingRef.current
    ) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
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
      className={`flex flex-col gap-2 p-4 border-2 border-[#e5e5e5] rounded-4xl ${
        className || ""
      }`}
    >
      <div className="w-full grid grid-cols-4 gap-2">
        {localUploadedFiles.length !== 0 &&
          localUploadedFiles.map((uploadFile) => (
            <FileItem
              id={uploadFile.id}
              key={uploadFile.id}
              fileName={uploadFile.file.name}
              parsedStatus={uploadFile.parsedStatus}
              sizeBytes={uploadFile.sizeBytes}
              ImgComponent={getFileIcon(
                uploadFile.file.type,
                uploadFile.file.name
              )}
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
        className="w-full px-3 py-2 border border-transparent rounded-md focus:outline-none resize-none overflow-y-auto scrollbar-hide"
        style={{
          minHeight: "40px",
          maxHeight: "100px",
          height: "auto",
        }}
      />
      <div className="flex w-full justify-between px-2 gap-2 items-center flex-wrap">
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
            className="p-2 w-10 h-8 rounded-3xl hover:bg-[#e7e7e7] hover:cursor-pointer"
            onClick={() => handleUploadClick()}
          />
          <ModelSelector showLabel={false} />
        </div>

        <button
          type="submit"
          className={`p-2 rounded-[50%] bg-black hover:cursor-pointer`}
        >
          {isChating ? (
            <div className="w-6 h-6 flex items-center justify-center">
              <div className="w-3.5 h-3.5 bg-white rounded-xs"></div>
            </div>
          ) : (
            <Image src="/send.svg" alt="发送" width={25} height={25} />
          )}
        </button>
      </div>
    </form>
  );
};

export default ChatInput;
