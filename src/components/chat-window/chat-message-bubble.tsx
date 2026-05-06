import { CheckCircleOutlined, LoadingOutlined } from "@ant-design/icons";
import { Button, Spin, message as antdMessage } from "antd";
import FileItem from "../files/file-items";
import CustomMarkdown from "../markdown/custom-markdown";
import MessageToolBar from "../message-tool-bar/message-tool-bar";

import { useState } from "react";
import { useCopy } from "@/utils/hooks";
import { useDeepResearchProcessStore, useConversationStore } from "@/store";
import { ChatMessageBubbleProps, SupportDownloadFileType } from "@/types";
import { reChatWithAssistant } from "@/utils/chat";
import {
  handleDownloadPDF,
  handleDownloadDOC,
  handleDownloadMD,
} from "@/utils/files/file-download";
import { getFileIcon } from "@/utils/files/file-info-handler";
import apiClient from "@/utils/request/api";

const ChatMessageBubble: React.FC<ChatMessageBubbleProps> = ({
  message,
  isLastAIMessage,
  isLastHumanMessage,
  selectDownloadId,
  setSelectDownloadId,
}) => {
  const deepResearchStore = useDeepResearchProcessStore();
  const conversationStore = useConversationStore();
  const {
    status,
    report,
    setStatus,
    setResearchTargt,
    setIsOpenProcessSider,
    setTasks,
    updateReport,
  } = deepResearchStore;
  const {
    currentMessages,
    isChating,
    currentAbortController,
    abortCurrentChat,
  } = conversationStore;
  const [isShowOtherOperators, setIsShowOtherOperators] =
    useState<boolean>(false);
  const { copyToClipboard } = useCopy();
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [reEditValue, setReEditValue] = useState<string>(
    message.content as string
  );

  // 点击查看深度研究结果的处理逻辑
  const hanldeShowDeepResearch = async () => {
    if (status === "processing") return;
    const response = await apiClient.post(
      "/conversations/get_deep_research_result",
      { session_id: message.sessionId, message_id: message.id }
    );
    const deepResearchResult = response.data;
    if (!deepResearchResult) {
      console.error("出错了，没有研究结果");
      return;
    }
    setStatus("notCall");
    setIsOpenProcessSider(true);
    setResearchTargt(deepResearchResult.researchTarget || "");
    setTasks(deepResearchResult.tasks || []);
    updateReport(deepResearchResult.report);
  };

  const renderContent = () => {
    if (typeof message.content === "string") {
      return message.content;
    }
    return JSON.stringify(message.content);
  };

  // 处理复制等其他操作
  const renderAdditionalOperator = (role: string) => {
    //常量
    const userMessagesTools: ("copy" | "edit")[] = ["copy"];
    const aiMessagesTools: ("copy" | "recall" | "download")[] = [
      "copy",
      "download",
    ];
    const userLastMessagesTools: ("copy" | "edit")[] = ["copy", "edit"];
    const aiLastMessagesTools: ("copy" | "recall" | "download")[] = [
      "copy",
      "recall",
      "download",
    ];
    const supportDownloadFiles: SupportDownloadFileType[] = [
      "pdf",
      "word",
      "md",
      "cancel",
    ];

    const handleOperator = async (
      op: "copy" | "edit" | "recall" | "download"
    ) => {
      switch (op) {
        case "copy": {
          copyToClipboard(renderContent());
          return;
        }
        case "edit": {
          setIsEditing(true);
          return;
        }
        case "recall": {
          await reChatWithAssistant({
            callingMode: "recall",
            inputValue: message.content as string,
            mode: message.mode,
            ...conversationStore,
            ...deepResearchStore,
          });
        }
        case "download": {
          if (selectDownloadId === message.id) {
            setSelectDownloadId(0);
          } else {
            setSelectDownloadId(message.id);
          }
        }
      }
    };

    const handleDownloadFiles = (fileType: SupportDownloadFileType) => {
      switch (fileType) {
        case "pdf": {
          handleDownloadPDF(
            message.mode === "deepResearch"
              ? message.deepResearchResult?.report || ""
              : (message.content as string)
          );
          return;
        }
        case "word": {
          handleDownloadDOC(
            message.mode === "deepResearch"
              ? message.deepResearchResult?.report || ""
              : (message.content as string)
          );
          return;
        }
        case "md": {
          handleDownloadMD(
            message.mode === "deepResearch"
              ? message.deepResearchResult?.report || ""
              : (message.content as string)
          );
          return;
        }
        case "cancel": {
          return;
        }
      }
    };

    return (
      <div
        className={`absolute -bottom-10  flex transition-all  ${
          role === "user" ? "justify-end" : "justify-start"
        } ${isShowOtherOperators ? "opacity-100" : "opacity-0"}`}
        onMouseEnter={() => setIsShowOtherOperators(true)}
        onMouseLeave={() => setIsShowOtherOperators(false)}
      >
        {role === "user" ? (
          <MessageToolBar
            tools={
              isLastHumanMessage ? userLastMessagesTools : userMessagesTools
            }
            supportDownloadFiles={supportDownloadFiles}
            handleToolAction={handleOperator}
            handleDownloadFiles={handleDownloadFiles}
          />
        ) : (
          <MessageToolBar
            tools={isLastAIMessage ? aiLastMessagesTools : aiMessagesTools}
            supportDownloadFiles={supportDownloadFiles}
            handleToolAction={handleOperator}
            handleDownloadFiles={handleDownloadFiles}
          />
        )}
      </div>
    );
  };

  // 深度研究状态显示框展示逻辑
  const renderShowDeepResearch = () => {
    if (
      message.mode !== "deepResearch" ||
      message.role !== "assistant" ||
      message.researchStatus === "failed"
    ) {
      return null;
    }

    // 历史已经完成的深度研究
    if (
      message.researchStatus === "finished" &&
      message.deepResearchResult?.report
    ) {
      return (
        <>
          <Button
            className="h-4 w-2xs rounded-2xl"
            onClick={() => hanldeShowDeepResearch()}
          >
            <CheckCircleOutlined style={{ color: "green" }} />{" "}
            深度研究完成,查看研究过程
          </Button>
          <div className="mt-4 p-6 border-2 border-gray-200 rounded-md bg-white relative">
            <div className="text-gray-800 leading-relaxed">
              <CustomMarkdown
                content={message.deepResearchResult?.report.slice(0, 300) || ""}
              />
            </div>
            <div
              onClick={() => hanldeShowDeepResearch()}
              className="h-1/2 w-full absolute left-0 bottom-0 z-10 flex items-center justify-center"
              style={{
                background:
                  "linear-gradient(to top, rgba(255, 255, 255, 1), transparent)",
              }}
            >
              <Button
                className="h-6 w-30 rounded-2xl"
                onClick={() => hanldeShowDeepResearch()}
              >
                展开文档
              </Button>
            </div>
          </div>
        </>
      );
    }

    // 当前正在进行的深度研究
    if (status !== "notCall") {
      return (
        <>
          <Button
            className="h-4 w-2xs rounded-2xl"
            onClick={() => hanldeShowDeepResearch()}
          >
            {status === "end" ? (
              <>
                <CheckCircleOutlined style={{ color: "green" }} />{" "}
                深度研究完成,查看研究过程
              </>
            ) : (
              <>
                <LoadingOutlined />
                正在进行深度研究
              </>
            )}
          </Button>
          {status === "end" && report && (
            <div className="mt-4 p-6 border-2 border-gray-200 rounded-md bg-white relative">
              <div className="text-gray-800 leading-relaxed">
                <CustomMarkdown content={report.slice(0, 300) || ""} />
              </div>
              <div
                onClick={() => hanldeShowDeepResearch()}
                className="h-1/2 w-full absolute left-0 bottom-0 z-10 flex items-center justify-center"
                style={{
                  background:
                    "linear-gradient(to top, rgba(255, 255, 255, 1), transparent)",
                }}
              >
                <Button
                  className="h-6 w-30 rounded-2xl"
                  onClick={() => hanldeShowDeepResearch()}
                >
                  展开文档
                </Button>
              </div>
            </div>
          )}
        </>
      );
    }
  };

  // user气泡
  if (message.role === "user") {
    const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      if (isChating) {
        if (currentAbortController) {
          abortCurrentChat();
        }
        setIsEditing(false);
        return;
      }

      if (reEditValue.trim()) {
        setIsEditing(false);
        await reChatWithAssistant({
          callingMode: "reEditCall",
          inputValue: reEditValue,
          mode: currentMessages[currentMessages.length - 1].mode,
          ...conversationStore,
          ...deepResearchStore,
        });
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      e.stopPropagation();
      if (isChating) {
        setIsEditing(false);
        return;
      }
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        reEditValue.trim() !== renderContent()
      ) {
        e.preventDefault();
        handleSubmit(e);
      }
    };

    // 正常气泡
    if (!isEditing) {
      return (
        <div className="w-full px-3 mb-5 flex flex-col gap-2 items-end relative">
          <div className="w-1/3 grid grid-cols-1 gap-2">
            {message.files &&
              message.files.length !== 0 &&
              message.files.map((file) => (
                <FileItem
                  id={file.id as string}
                  key={file.id as KeyType}
                  fileName={file.filename}
                  parsedStatus={"success"}
                  sizeBytes={file.sizeBytes}
                  ImgComponent={getFileIcon(file.mimeType, file.filename)}
                  canClose={false}
                />
              ))}
          </div>
          <div
            className="max-w-2/3 p-3 rounded-3xl bg-sky-100"
            onMouseEnter={() => setIsShowOtherOperators(true)}
            onMouseLeave={() => setIsShowOtherOperators(false)}
          >
            <CustomMarkdown content={renderContent()} />
          </div>
          {renderAdditionalOperator(message.role)}
        </div>
      );
    } else {
      // 编辑气泡
      return (
        <div className="w-full px-3 mb-5 flex flex-col gap-2 items-end relative">
          <textarea
            value={reEditValue}
            onChange={(e) => setReEditValue(e.target.value)}
            onKeyDown={(e) => handleKeyDown(e)}
            rows={1}
            className="w-2/3 px-3 py-2 border-2 border-sky-400 rounded-md focus:outline-none resize-none overflow-y-auto scrollbar-hide"
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
          <div className="flex gap-2">
            <Button onClick={(e) => handleSubmit(e)}>确定</Button>
            <Button
              onClick={(e) => {
                e.stopPropagation();
                setReEditValue(message.content as string);
                setIsEditing(false);
              }}
            >
              取消
            </Button>
          </div>
        </div>
      );
    }
  }

  // loading气泡
  if (
    message.role === "assistant" &&
    (message.content === "" ||
      (Array.isArray(message) && !message.content.length))
  ) {
    return (
      <Spin
        indicator={<LoadingOutlined style={{ color: "#828282" }} />}
        size="large"
      ></Spin>
    );
  }

  // ai气泡
  return (
    <div className="w-full flex px-3 mb-5 justify-start flex-wrap relative">
      <div
        className="max-w-2/3 p-3 rounded-3xl bg-white flex flex-col gap-4"
        onMouseEnter={() => setIsShowOtherOperators(true)}
        onMouseLeave={() => setIsShowOtherOperators(false)}
      >
        <CustomMarkdown content={renderContent()} />
        {renderShowDeepResearch()}
      </div>
      {renderAdditionalOperator(message.role)}
    </div>
  );
};

export default ChatMessageBubble;
