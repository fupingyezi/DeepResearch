import React, { useState, useRef } from "react";
import Image from "next/image";
import FileItem from "../Files/FileItems";
import { formatFileSize, getFileIcon } from "@/utils/files/fileInfoHandler";
import { ChatInputProps, UploadedFile } from "@/types";
import {
  agentMode,
  useChatSelectStore,
  useConversationStore,
  useFileUploadStore,
} from "@/store";
import { v4 as uuidv4 } from "uuid";
import apiClient from "@/utils/request/api";

const SUPPORTED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "text/markdown",
  "text/plain",
  "text/x-markdown",
];

const ChatInput: React.FC<ChatInputProps> = ({
  placeholder,
  onSend,
  disabled = false,
  className,
}) => {
  const { isChating, currentAbortController, abortCurrentChat } =
    useConversationStore();
  const { selectedAgent, setSelectedAgent } = useChatSelectStore();
  const { uploadedFiles, addUploadedFile, removeUploadedFile } =
    useFileUploadStore();
  const [inputValue, setInputValue] = useState("");
  const [localUploadedFiles, setLocalUploadedFiles] = useState<UploadedFile[]>(
    []
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const supportUploadFiles = selectedAgent === "chat";

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
      const hasFiles = uploadedFiles.length > 0;
      onSend(inputValue.trim(), hasFiles);
      setInputValue("");
      setLocalUploadedFiles([]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isChating) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const hanleSelect = (e: any, agent: agentMode) => {
    e.stopPropagation();
    console.log("select agent:", agent);
    if (selectedAgent === agent) {
      setSelectedAgent("chat");
    } else {
      setSelectedAgent(agent);
    }
  };

  const handleUploadClick = () => {
    if (fileInputRef.current && supportUploadFiles) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    const newFiles: UploadedFile[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];

      // 校验类型
      if (
        !SUPPORTED_TYPES.includes(file.type) &&
        !/\.(md|txt)$/i.test(file.name)
      ) {
        alert(`不支持的文件类型: ${file.name}`);
        continue;
      }

      // 校验大小，10MB以内
      if (file.size > 10 * 1024 * 1024) {
        alert(`文件过大（>${formatFileSize(10 * 1024 * 1024)}）: ${file.name}`);
        continue;
      }

      const fileId = uuidv4();
      newFiles.push({
        id: fileId,
        file,
        parsedStatus: "pending",
      });

      setLocalUploadedFiles((prev) => [
        ...prev,
        { id: fileId, file, parsedStatus: "pending" },
      ]);
    }

    for (const newFile of newFiles) {
      await parseFile(newFile.id, newFile.file);
    }
  };

  // 解析文件
  const parseFile = async (fileId: string, file: File) => {
    setLocalUploadedFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, parsedStatus: "parsing" } : f))
    );

    const formData = new FormData();
    formData.append("file", file);
    formData.append("fileId", fileId);

    try {
      const result = await apiClient.post("/files/upload", formData);
      // console.log("response.result", result);

      // 更新本地状态
      setLocalUploadedFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? {
                ...f,
                parsedStatus: result.error ? "failed" : "success",
                sizeBytes: file.size,
                error: result.error,
              }
            : f
        )
      );

      // 添加到全局状态
      addUploadedFile({
        fileId: result.fileId,
        minioKey: result.minioKey,
        filename: result.filename,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
        content: result.content,
        error: result.error,
      });
    } catch (error: any) {
      console.error("Parse failed:", error);
      setLocalUploadedFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? {
                ...f,
                parsedStatus: "failed",
                error: error.message || "解析失败",
              }
            : f
        )
      );
    }
  };

  const removeFile = async (id: string) => {
    setLocalUploadedFiles((prev) => prev.filter((f) => f.id !== id));
    removeUploadedFile(id);

    try {
      await apiClient.delete("/files/delete", {
        body: JSON.stringify({ fileId: id }),
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      console.error("Failed to delete file from server:", error);
    }
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
      <div className="flex w-full justify-between px-2">
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
          ></Image>
          <div
            className="w-30 h-8 rounded-2xl border-[#f3f3f3] border-2 flex justify-center items-center hover:cursor-pointer hover:bg-[#e7e7e7]"
            onClick={(e) => hanleSelect(e, "search")}
            style={{
              backgroundColor: selectedAgent === "search" ? "#eceaff" : "",
              color: selectedAgent === "search" ? "#4433ff" : "",
            }}
          >
            联网搜索
          </div>
          <div
            className="w-30 h-8 rounded-2xl border-[#f3f3f3] border-2 flex justify-center items-center hover:cursor-pointer hover:bg-[#e7e7e7]"
            onClick={(e) => hanleSelect(e, "deepResearch")}
            style={{
              backgroundColor:
                selectedAgent === "deepResearch" ? "#eceaff" : "",
              color: selectedAgent === "deepResearch" ? "#4433ff" : "",
            }}
          >
            深度研究
          </div>
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
            <Image src="/send.svg" alt="发送" width={25} height={25}></Image>
          )}
        </button>
      </div>
    </form>
  );
};

export default ChatInput;
