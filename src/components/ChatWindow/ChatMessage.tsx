import Image from "next/image";
import CustomMarkdown from "../Markdown/CustomMarkdown";
import FileItem from "../Files/FileItems";
import { getFileIcon, formatFileSize } from "@/utils/files/fileInfoHandler";
import {
  handleDownloadMD,
  handleDownloadPDF,
  handleDownloadDOC,
} from "@/utils/files/fileDownload";
import { Button, Spin, Tooltip, Popover, message as antdMessage } from "antd";
import { LoadingOutlined, CheckCircleOutlined } from "@ant-design/icons";

import { ChatMessagesProps, ChatMessageBubbleProps } from "@/types";
import React, { useState, useRef, useEffect, useCallback } from "react";
import apiClient from "@/utils/request/api";
import copy from "copy-to-clipboard";
import { useDeepResearchProcessStore, useConversationStore } from "@/store";
import { reChatWithAssistant } from "@/utils/chat";

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
  const [showCopySuccess, setShowCopySuccess] = useState<boolean>(false);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [reEditValue, setReEditValue] = useState<string>(
    message.content as string
  );

  useEffect(() => {
    if (showCopySuccess) {
      antdMessage.success("Copy Success!");
      const timer = setTimeout(() => {
        setShowCopySuccess(false);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [showCopySuccess]);

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
    const userMessagesOperators: ("copy" | "edit")[] = ["copy", "edit"];
    const aiMessagesOperators: ("copy" | "recall" | "download")[] = [
      "copy",
      "recall",
      "download",
    ];
    const operatorToTextMap = (op: "copy" | "edit" | "recall" | "download") => {
      switch (op) {
        case "copy":
          return "复制";
        case "edit":
          return "编辑";
        case "recall":
          return "重新生成";
        case "download":
          return "下载";
      }
    };

    const handleOperator = async (
      op: "copy" | "edit" | "recall" | "download"
    ) => {
      switch (op) {
        case "copy": {
          copy(renderContent());
          setShowCopySuccess(true);
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

    return (
      <div
        className={`absolute -bottom-10  flex transition-all  ${
          role === "user" ? "justify-end" : "justify-start"
        } ${isShowOtherOperators ? "opacity-100" : "opacity-0"}`}
        onMouseEnter={() => setIsShowOtherOperators(true)}
        onMouseLeave={() => setIsShowOtherOperators(false)}
      >
        {(role === "user" ? userMessagesOperators : aiMessagesOperators).map(
          (op, index) => {
            if (!isLastAIMessage && op === "recall") return null;
            if (!isLastHumanMessage && op === "edit") return null;
            return (
              <Tooltip
                key={index}
                title={`${operatorToTextMap(op)}`}
                placement="bottom"
              >
                <Popover
                  content={
                    <div onClick={(e) => e.stopPropagation()}>
                      <div
                        className="flex gap-2 items-center px-2 py-1 hover:bg-gray-100 hover:cursor-pointer rounded-md"
                        onClick={() => {
                          handleDownloadPDF(
                            message.mode === "deepResearch"
                              ? message.deepResearchResult?.report || ""
                              : (message.content as string)
                          );
                          setSelectDownloadId(0);
                        }}
                      >
                        pdf
                      </div>
                      <div
                        className="flex gap-2 items-center px-2 py-1 hover:bg-gray-100 hover:cursor-pointer rounded-md"
                        onClick={() => {
                          handleDownloadDOC(
                            message.mode === "deepResearch"
                              ? message.deepResearchResult?.report || ""
                              : (message.content as string)
                          );
                          setSelectDownloadId(0);
                        }}
                      >
                        word
                      </div>
                      <div
                        className="flex gap-2 items-center px-2 py-1 hover:bg-gray-100 hover:cursor-pointer rounded-md"
                        onClick={() => {
                          handleDownloadMD(
                            message.mode === "deepResearch"
                              ? message.deepResearchResult?.report || ""
                              : (message.content as string)
                          );
                          setSelectDownloadId(0);
                        }}
                      >
                        markdown
                      </div>
                      <div
                        className="flex gap-2 items-center px-2 py-1 hover:bg-gray-100 hover:cursor-pointer rounded-md"
                        onClick={() => setSelectDownloadId(0)}
                      >
                        取消
                      </div>
                    </div>
                  }
                  placement="right"
                  open={op === "download" && selectDownloadId === message.id}
                >
                  <Image
                    src={`/${op}.svg`}
                    alt={`${op}`}
                    width={20}
                    height={20}
                    className="w-7 h-7 rounded-xl p-1 m-0.5 mb-2 hover:bg-[#e7e7e7] hover:cursor-pointer"
                    onClick={() => handleOperator(op)}
                  ></Image>
                </Popover>
              </Tooltip>
            );
          }
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
    if (message.researchStatus === "finished") {
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
            {status === "processing" ? (
              <>
                <LoadingOutlined />
                正在进行深度研究
              </>
            ) : (
              <>
                <CheckCircleOutlined style={{ color: "green" }} />{" "}
                深度研究完成,查看研究过程
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

const ChatMessage: React.FC<ChatMessagesProps> = ({
  messages,
  emptyStateComponent,
  shouldAutoScroll,
  setShouldAutoScroll,
  className,
}) => {
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [selectDownloadId, setSelectDownLoadId] = useState<number>(0);

  const scrollToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container || !shouldAutoScroll) return;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth",
    });
  }, [shouldAutoScroll]);

  const checkShouldAutoScroll = useCallback(
    (wheelEvent?: React.WheelEvent<HTMLDivElement>) => {
      if (!messagesContainerRef.current) return;

      const { scrollTop, scrollHeight, clientHeight } =
        messagesContainerRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;

      if (wheelEvent && wheelEvent.deltaY < 0 && !isAtBottom) {
        setShouldAutoScroll(false);
        return;
      }
      if (isAtBottom) {
        setShouldAutoScroll(true);
      }
    },
    [setShouldAutoScroll]
  );

  useEffect(() => {
    if (messagesContainerRef.current && shouldAutoScroll) {
      scrollToBottom();
    }
  }, [messages, scrollToBottom, shouldAutoScroll]);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, scrollToBottom]);

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
          key={index}
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
