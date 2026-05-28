import React, { useState, useRef, useLayoutEffect } from "react";
import { useFileUpload } from "@/utils/hooks";
import Image from "next/image";
import FileItem from "../files/file-items";
import { ChatInputProps } from "@/types";
import { useConversationStore } from "@/store";
import ModelSelector from "../model-selector/model-selector";

/**
 * ChatInput —— 对齐 deer-flow 2.0
 *
 * 单一输入入口：用户只输入文本（含可选附件），是否走深度研究 / 是否联网搜索
 * 完全交给后端 lead-agent 自主判断。前端不再呈现"联网搜索 / 深度研究"两档。
 */
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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

  // 高度自适应：把读 scrollHeight + 写 height 收敛到一次 layout 帧内，
  // 避免在 onInput 里每次按键都触发同步 reflow。
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
    // IME 组合中（包括 compositionend 之后的同 tick 残余），不发送
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
          // compositionend 之后，部分浏览器还会再派发一次 keydown(Enter)。
          // 用 setTimeout(0) 跨过整个事件循环当前任务，比 queueMicrotask
          // 更稳——后者在某些 IME / React 18 同步事件批处理下仍可能早于
          // 那次补发的 keydown 执行，从而误判为发送。
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
