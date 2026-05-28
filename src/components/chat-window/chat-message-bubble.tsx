import { LoadingOutlined, FileTextOutlined } from "@ant-design/icons";
import { Button, Spin } from "antd";
import FileItem from "../files/file-items";
import CustomMarkdown from "../markdown/custom-markdown";
import MessageToolBar from "../message-tool-bar/message-tool-bar";
import MessageTimeline from "./message-timeline";

import { useState, useMemo } from "react";
import { useCopy } from "@/utils/hooks";
import { useConversationStore, useArtifactPanelStore } from "@/store";
import {
  ChatMessageBubbleProps,
  MessageArtifact,
  MessageTimeline as MessageTimelineType,
  SupportDownloadFileType,
} from "@/types";
import { chatWithAgent } from "@/utils/chat";
import {
  handleDownloadPDF,
  handleDownloadDOC,
  handleDownloadMD,
} from "@/utils/files/file-download";
import { getFileIcon } from "@/utils/files/file-info-handler";

const ChatMessageBubble: React.FC<ChatMessageBubbleProps> = ({
  message,
  isLastAIMessage,
  isLastHumanMessage,
  selectDownloadId,
  setSelectDownloadId,
}) => {
  const isChating = useConversationStore((s) => s.isChating);
  const currentAbortController = useConversationStore(
    (s) => s.currentAbortController
  );
  const abortCurrentChat = useConversationStore((s) => s.abortCurrentChat);
  const openArtifact = useArtifactPanelStore((s) => s.openArtifact);

  const [isShowOtherOperators, setIsShowOtherOperators] =
    useState<boolean>(false);
  const { copyToClipboard } = useCopy();
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [reEditValue, setReEditValue] = useState<string>(
    message.content as string
  );

  /**
   * 兼容旧消息：若历史消息只有 deepResearchResult 字段，把它降级为
   * 一个最简化的 timeline + artifact，仅供历史回放。
   */
  const { effectiveTimeline, effectiveArtifact } = useMemo<{
    effectiveTimeline?: MessageTimelineType;
    effectiveArtifact?: MessageArtifact;
  }>(() => {
    if (message.timeline || message.artifact) {
      return {
        effectiveTimeline: message.timeline,
        effectiveArtifact: message.artifact,
      };
    }
    if (message.mode === "deepResearch" && message.deepResearchResult) {
      const dr = message.deepResearchResult;
      const timeline: MessageTimelineType = {
        steps: (dr.tasks || []).map((t, idx) => ({
          kind: "subagent_task" as const,
          id: t.id || t.taskId || String(idx),
          taskId: t.taskId || String(idx),
          description: t.description,
          status: t.result ? "completed" : "running",
          result: t.result,
        })),
        status:
          message.researchStatus === "finished"
            ? "end"
            : message.researchStatus === "failed"
            ? "failed"
            : message.researchStatus === "suspended"
            ? "interrupt"
            : "processing",
      };
      return {
        effectiveTimeline: timeline,
        effectiveArtifact: dr.report
          ? { title: dr.researchTarget || "研究报告", content: dr.report }
          : undefined,
      };
    }
    return {};
  }, [
    message.timeline,
    message.artifact,
    message.mode,
    message.deepResearchResult,
    message.researchStatus,
  ]);

  const renderContent = () => {
    if (typeof message.content === "string") {
      return message.content;
    }
    return JSON.stringify(message.content);
  };

  const handleOpenArtifact = () => {
    if (!effectiveArtifact) return;
    openArtifact({
      sessionId:
        typeof message.sessionId === "string"
          ? message.sessionId
          : String(message.sessionId ?? ""),
      messageId: message.id,
      title: effectiveArtifact.title,
      report: effectiveArtifact.content,
    });
  };

  // 处理复制等其他操作
  const renderAdditionalOperator = (role: string) => {
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
          // deer-flow 2.0 风格：re-call 不再读取 message.mode 决定档位，
          // 是否进入深度研究流程由后端 lead-agent 自主判断。
          await chatWithAgent({
            callingMode: "recall",
            inputValue: message.content as string,
            // 事件回调里取最新 store 快照，无需把整个 store 作为响应式依赖。
            ...useConversationStore.getState(),
          });
          return;
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

    /** 下载内容来源：优先 artifact.content，其次正文 */
    const getDownloadSource = () => {
      if (effectiveArtifact?.content) return effectiveArtifact.content;
      return (message.content as string) || "";
    };

    const handleDownloadFiles = (fileType: SupportDownloadFileType) => {
      const src = getDownloadSource();
      switch (fileType) {
        case "pdf":
          handleDownloadPDF(src);
          return;
        case "word":
          handleDownloadDOC(src);
          return;
        case "md":
          handleDownloadMD(src);
          return;
        case "cancel":
          return;
      }
    };

    return (
      <div
        className={`absolute -bottom-10 flex transition-all ${
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
        // deer-flow 2.0 风格：reEditCall 不再读 message.mode 决定档位，
        // 后端 lead-agent 自主判断是否进入深度研究。
        await chatWithAgent({
          callingMode: "reEditCall",
          inputValue: reEditValue,
          ...useConversationStore.getState(),
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

  // loading 气泡：assistant 还没有 timeline 也没有正文
  if (
    message.role === "assistant" &&
    (!effectiveTimeline || effectiveTimeline.steps.length === 0) &&
    !effectiveArtifact &&
    (message.content === "" ||
      (Array.isArray(message.content) && !message.content.length))
  ) {
    return (
      <Spin
        indicator={<LoadingOutlined style={{ color: "#828282" }} />}
        size="large"
      />
    );
  }

  // ai 气泡（含内联工作流时间线 + 产物入口）
  return (
    <div className="w-full flex px-3 mb-5 justify-start flex-wrap relative">
      <div
        className="max-w-2/3 p-3 rounded-3xl bg-white flex flex-col gap-2"
        onMouseEnter={() => setIsShowOtherOperators(true)}
        onMouseLeave={() => setIsShowOtherOperators(false)}
      >
        {/* 工作流时间线（reasoning / tool_call / subagent_task） */}
        <MessageTimeline timeline={effectiveTimeline} />

        {/* 正文 */}
        {typeof message.content === "string" && message.content.length > 0 && (
          <CustomMarkdown content={renderContent()} />
        )}

        {/* 产物入口（点击打开右侧 ArtifactPanel） */}
        {effectiveArtifact && (
          <button
            type="button"
            onClick={handleOpenArtifact}
            className="w-full mt-1 flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-left hover:border-blue-400 hover:bg-blue-50/40 transition-colors"
          >
            <div className="flex items-center gap-2">
              <FileTextOutlined className="text-blue-500" />
              <span className="text-sm font-medium text-gray-700 truncate">
                {effectiveArtifact.title}
              </span>
            </div>
            <span className="text-xs text-blue-500 shrink-0">查看产物 →</span>
          </button>
        )}
      </div>
      {renderAdditionalOperator(message.role)}
    </div>
  );
};

export default ChatMessageBubble;
