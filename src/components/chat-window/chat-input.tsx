import React, { useState, useRef } from "react";
import { useFileUpload } from "@/utils/hooks";
import Image from "next/image";
import FileItem from "../files/file-items";
import { ChatInputProps } from "@/types";
import { useConversationStore } from "@/store";
import ModelSelector from "../model-selector/model-selector";

type ModeKey = "search" | "deepResearch";

const ChatInput: React.FC<ChatInputProps> = ({
  placeholder,
  onSend,
  disabled = false,
  className,
}) => {
  // 仅订阅渲染需要的字段，避免不带 selector 的 useConversationStore() 在
  // 流式 setCurrentMessages 高频触发时引发整个 ChatInput re-render（含
  // 子组件 ModelSelector 等）。
  const isChating = useConversationStore((s) => s.isChating);
  const currentAbortController = useConversationStore(
    (s) => s.currentAbortController
  );
  const abortCurrentChat = useConversationStore((s) => s.abortCurrentChat);
  const [inputValue, setInputValue] = useState("");
  /** 模式开关（互斥）：null = 普通对话 */
  const [activeMode, setActiveMode] = useState<ModeKey | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // 中文/日文等输入法 composition（候选词）状态。处于组合中时，回车用于
  // 选词/确认候选，不应触发发送。
  const isComposingRef = useRef(false);
  const {
    localUploadedFiles,
    handleFiles,
    removeFile,
    clearFiles,
    getFileIcon,
  } = useFileUpload();
  /** 仅普通对话支持文件上传（与原行为保持一致） */
  const supportUploadFiles = activeMode === null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!localUploadedFiles.every((file) => file.parsedStatus === "success")) {
      return;
    }

    if (isChating) {
      if (currentAbortController) {
        abortCurrentChat();
      }
      return;
    }

    if (inputValue.trim() && onSend && !disabled) {
      const hasFiles = localUploadedFiles.length > 0;
      onSend(inputValue.trim(), {
        hasFiles,
        enableSearch: activeMode === "search",
        enableDeepResearch: activeMode === "deepResearch",
      });
      setInputValue("");
      clearFiles();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isChating) return;
    // 输入法组合中按回车（选词/上屏）不应触发发送：
    // 1. e.nativeEvent.isComposing：现代浏览器标准
    // 2. e.keyCode === 229：老内核（Safari/部分 IME）兜底
    // 3. isComposingRef：compositionend 之后浏览器还会派发一次 keydown(Enter)，
    //    用 ref 在 compositionend 里短暂保留状态，避免该次回车被误判为发送。
    if (
      e.nativeEvent.isComposing ||
      e.keyCode === 229 ||
      isComposingRef.current
    ) {
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const toggleMode = (e: React.MouseEvent, mode: ModeKey) => {
    e.stopPropagation();
    setActiveMode((cur) => (cur === mode ? null : mode));
  };

  const handleUploadClick = () => {
    if (fileInputRef.current && supportUploadFiles) {
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
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={() => {
          queueMicrotask(() => {
            isComposingRef.current = false;
          });
        }}
        placeholder={placeholder}
        rows={1}
        className="w-full px-3 py-2 border border-transparent rounded-md focus:outline-none resize-none overflow-y-auto scrollbar-hide"
        style={{
          minHeight: "40px",
          maxHeight: "100px",
          height: "auto",
        }}
        onInput={(e) => {
          const target = e.target as HTMLTextAreaElement;
          target.style.height = "auto";
          target.style.height = Math.min(target.scrollHeight, 100) + "px";
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
            className={`p-2 w-10 h-8 rounded-3xl ${
              supportUploadFiles
                ? "hover:bg-[#e7e7e7] hover:cursor-pointer"
                : "opacity-40 cursor-not-allowed"
            }`}
            onClick={() => handleUploadClick()}
          />
          <div
            className="w-30 h-8 rounded-2xl border-[#f3f3f3] border-2 flex justify-center items-center hover:cursor-pointer hover:bg-[#e7e7e7]"
            onClick={(e) => toggleMode(e, "search")}
            style={{
              backgroundColor: activeMode === "search" ? "#eceaff" : "",
              color: activeMode === "search" ? "#4433ff" : "",
            }}
          >
            联网搜索
          </div>
          <div
            className="w-30 h-8 rounded-2xl border-[#f3f3f3] border-2 flex justify-center items-center hover:cursor-pointer hover:bg-[#e7e7e7]"
            onClick={(e) => toggleMode(e, "deepResearch")}
            style={{
              backgroundColor:
                activeMode === "deepResearch" ? "#eceaff" : "",
              color: activeMode === "deepResearch" ? "#4433ff" : "",
            }}
          >
            深度研究
          </div>
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
