import { LoadingOutlined, FileTextOutlined } from '@ant-design/icons';
import { Button, Spin } from 'antd';
import FileItem from '../files/file-items';
import CustomMarkdown from '../markdown/custom-markdown';
import MessageToolBar from '../message-tool-bar/message-tool-bar';
import MessageTimeline from './message-timeline';

import { useMemo, useState } from 'react';
import { useCopy } from '@/hooks';
import { useConversationStore, useArtifactPanelStore } from '@/store';
import {
  ChatMessageBubbleProps,
  SupportDownloadFileType,
  isArtifactPart,
  isFilePart,
  isImagePart,
  isReasoningPart,
  isSubagentTaskPart,
  isTaskSummaryPart,
  isTextPart,
  isToolCallPart,
  type MessagePart,
  type MessageTimelineProps,
  type TimelineStepPart,
} from '@/types';
import { chatWithAgent } from '@/utils/chat';
import {
  handleDownloadPDF,
  handleDownloadDOC,
  handleDownloadMD,
} from '@/utils/files/file-download';
import { getFileIcon } from '@/utils/files/file-info-handler';

/**
 * 从 parts[] 派生：
 *   - bodyText：所有 text part 拼接（用于正文渲染 + 复制 + 下载兜底）
 *   - timelineSteps：reasoning / tool_call / subagent_task 三类 part 子集
 *   - artifactPart：第一个 artifact part（点击右侧入口卡片打开 ArtifactPanel）
 *   - taskSummaryPart：第一个 task_summary part（多 agent 工作流的任务总结）
 *   - isMultiAgent：本轮是否为多 agent 工作流（存在 ≥1 个 subagent_task part）
 */
function deriveFromParts(parts: MessagePart[]): {
  bodyText: string;
  timelineSteps: TimelineStepPart[];
  artifactPart: Extract<MessagePart, { type: 'artifact' }> | null;
  taskSummaryPart: Extract<MessagePart, { type: 'task_summary' }> | null;
  isMultiAgent: boolean;
  filePartsForUser: Array<Extract<MessagePart, { type: 'file' | 'image' }>>;
} {
  const textSegments: string[] = [];
  const timelineSteps: TimelineStepPart[] = [];
  let artifactPart: Extract<MessagePart, { type: 'artifact' }> | null = null;
  let taskSummaryPart: Extract<MessagePart, { type: 'task_summary' }> | null = null;
  let isMultiAgent = false;
  const filePartsForUser: Array<Extract<MessagePart, { type: 'file' | 'image' }>> = [];

  for (const part of parts) {
    if (isTextPart(part)) {
      if (part.content.text.length > 0) textSegments.push(part.content.text);
      continue;
    }
    if (isReasoningPart(part) || isToolCallPart(part) || isSubagentTaskPart(part)) {
      if (isSubagentTaskPart(part)) isMultiAgent = true;
      timelineSteps.push(part);
      continue;
    }
    if (isArtifactPart(part)) {
      if (!artifactPart) artifactPart = part;
      continue;
    }
    if (isTaskSummaryPart(part)) {
      if (!taskSummaryPart) taskSummaryPart = part;
      continue;
    }
    if (isFilePart(part) || isImagePart(part)) {
      filePartsForUser.push(part);
      continue;
    }
    // tool_result 兜底 part 不在 timeline 中显示
  }

  return {
    bodyText: textSegments.join('\n\n'),
    timelineSteps,
    artifactPart,
    taskSummaryPart,
    isMultiAgent,
    filePartsForUser,
  };
}

const ChatMessageBubble: React.FC<ChatMessageBubbleProps> = ({
  message,
  isLastAIMessage,
  isLastHumanMessage,
  selectDownloadId,
  setSelectDownloadId,
}) => {
  const isChating = useConversationStore((s) => s.isChating);
  const currentAbortController = useConversationStore((s) => s.currentAbortController);
  const abortCurrentChat = useConversationStore((s) => s.abortCurrentChat);
  const openArtifact = useArtifactPanelStore((s) => s.openArtifact);

  const [isShowOtherOperators, setIsShowOtherOperators] = useState<boolean>(false);
  const { copyToClipboard } = useCopy();
  const [isEditing, setIsEditing] = useState<boolean>(false);

  const derived = useMemo(() => deriveFromParts(message.parts ?? []), [message.parts]);
  const { bodyText, timelineSteps, artifactPart, taskSummaryPart, isMultiAgent, filePartsForUser } =
    derived;

  const [reEditValue, setReEditValue] = useState<string>(bodyText);

  /**
   * timeline 顶部状态：
   * - assistant 消息有 interrupt → 'interrupt'
   * - 当前正在 chating 且本条是最后一条 assistant → 'processing'
   * - 否则 → 'end'
   */
  const timelineStatus: MessageTimelineProps['status'] = (() => {
    if (message.interrupt) return 'interrupt';
    if (isLastAIMessage && isChating) return 'processing';
    return 'end';
  })();

  const handleOpenArtifact = () => {
    if (!artifactPart) return;
    openArtifact({
      sessionId:
        typeof message.sessionId === 'string' ? message.sessionId : String(message.sessionId ?? ''),
      messageId: message.id,
      title: artifactPart.content.title,
      report: artifactPart.content.markdown,
    });
  };

  const renderAdditionalOperator = (role: string) => {
    const userMessagesTools: ('copy' | 'edit')[] = ['copy'];
    const aiMessagesTools: ('copy' | 'recall' | 'download')[] = ['copy', 'download'];
    const userLastMessagesTools: ('copy' | 'edit')[] = ['copy', 'edit'];
    const aiLastMessagesTools: ('copy' | 'recall' | 'download')[] = ['copy', 'recall', 'download'];
    const supportDownloadFiles: SupportDownloadFileType[] = ['pdf', 'word', 'md', 'cancel'];

    /** 复制 / 下载 / recall 内容来源：优先 artifact.markdown，其次正文 */
    const getDownloadSource = () => {
      if (artifactPart) return artifactPart.content.markdown;
      return bodyText;
    };

    const handleOperator = async (op: 'copy' | 'edit' | 'recall' | 'download') => {
      switch (op) {
        case 'copy': {
          copyToClipboard(getDownloadSource());
          return;
        }
        case 'edit': {
          setReEditValue(bodyText);
          setIsEditing(true);
          return;
        }
        case 'recall': {
          await chatWithAgent({
            operation: 'recall',
            inputValue: getDownloadSource(),
            ...useConversationStore.getState(),
          });
          return;
        }
        case 'download': {
          if (selectDownloadId === message.id) {
            setSelectDownloadId('');
          } else {
            setSelectDownloadId(message.id);
          }
        }
      }
    };

    const handleDownloadFiles = (fileType: SupportDownloadFileType) => {
      const src = getDownloadSource();
      switch (fileType) {
        case 'pdf':
          handleDownloadPDF(src);
          return;
        case 'word':
          handleDownloadDOC(src);
          return;
        case 'md':
          handleDownloadMD(src);
          return;
        case 'cancel':
          return;
      }
    };

    return (
      <div
        className={`absolute -bottom-10 flex transition-all ${
          role === 'user' ? 'justify-end' : 'justify-start'
        } ${isShowOtherOperators ? 'opacity-100' : 'opacity-0'}`}
        onMouseEnter={() => setIsShowOtherOperators(true)}
        onMouseLeave={() => setIsShowOtherOperators(false)}
      >
        {role === 'user' ? (
          <MessageToolBar
            tools={isLastHumanMessage ? userLastMessagesTools : userMessagesTools}
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

  // user 气泡
  if (message.role === 'user') {
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
        await chatWithAgent({
          operation: 'reEditCall',
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
      if (e.key === 'Enter' && !e.shiftKey && reEditValue.trim() !== bodyText) {
        e.preventDefault();
        handleSubmit(e);
      }
    };

    if (!isEditing) {
      return (
        <div className="relative mb-5 flex w-full flex-col items-end gap-2 px-3">
          {/* 历史加载场景：file_metadata 表里的文件 */}
          {message.files && message.files.length !== 0 && (
            <div className="grid w-1/3 grid-cols-1 gap-2">
              {message.files.map((file) => (
                <FileItem
                  id={file.id}
                  key={file.id}
                  fileName={file.filename}
                  parsedStatus={'success'}
                  sizeBytes={file.sizeBytes}
                  ImgComponent={getFileIcon(file.mimeType, file.filename)}
                  canClose={false}
                />
              ))}
            </div>
          )}
          {/* 实时发送场景：parts 中的 file/image part */}
          {(!message.files || message.files.length === 0) && filePartsForUser.length > 0 && (
            <div className="grid w-1/3 grid-cols-1 gap-2">
              {filePartsForUser.map((part) => (
                <FileItem
                  id={part.content.fileId}
                  key={part.partId}
                  fileName={part.content.filename ?? part.content.fileId}
                  parsedStatus={'success'}
                  sizeBytes={part.content.sizeBytes}
                  ImgComponent={getFileIcon(
                    part.content.mimeType ?? '',
                    part.content.filename ?? '',
                  )}
                  canClose={false}
                />
              ))}
            </div>
          )}
          <div
            className="max-w-[75%] min-w-0 rounded-2xl rounded-tr-md bg-linear-to-br from-sky-100 to-teal-50 px-4 py-3 text-[15px] wrap-break-word text-gray-800 shadow-[0_1px_2px_rgba(16,24,40,0.05)]"
            onMouseEnter={() => setIsShowOtherOperators(true)}
            onMouseLeave={() => setIsShowOtherOperators(false)}
          >
            <CustomMarkdown content={bodyText} />
          </div>
          {renderAdditionalOperator(message.role)}
        </div>
      );
    }
    return (
      <div className="relative mb-5 flex w-full flex-col items-end gap-2 px-3">
        <textarea
          value={reEditValue}
          onChange={(e) => setReEditValue(e.target.value)}
          onKeyDown={(e) => handleKeyDown(e)}
          rows={1}
          className="scrollbar-hide w-2/3 resize-none overflow-y-auto rounded-md border-2 border-sky-400 px-3 py-2 focus:outline-none"
          style={{
            minHeight: '40px',
            maxHeight: '100px',
            height: 'auto',
          }}
          onInput={(e) => {
            const target = e.target as HTMLTextAreaElement;
            target.style.height = 'auto';
            target.style.height = Math.min(target.scrollHeight, 100) + 'px';
          }}
        />
        <div className="flex gap-2">
          <Button onClick={(e) => handleSubmit(e)}>确定</Button>
          <Button
            onClick={(e) => {
              e.stopPropagation();
              setReEditValue(bodyText);
              setIsEditing(false);
            }}
          >
            取消
          </Button>
        </div>
      </div>
    );
  }

  // loading 气泡：assistant 还没有任何 part
  if (message.role === 'assistant' && (!message.parts || message.parts.length === 0)) {
    return <Spin indicator={<LoadingOutlined style={{ color: '#828282' }} />} size="large" />;
  }

  // ai 气泡（含内联工作流时间线 + 产物入口）
  const artifactEntry = artifactPart ? (
    <button
      type="button"
      onClick={handleOpenArtifact}
      className="group mt-1 flex w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-left shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-all hover:border-teal-300 hover:bg-teal-50/40 hover:shadow-[0_4px_12px_rgba(16,24,40,0.08)]"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
          <FileTextOutlined />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-gray-800">
            {artifactPart.content.title}
          </span>
          <span className="text-[11px] text-gray-400">点击查看完整研究报告</span>
        </div>
      </div>
      <span className="shrink-0 text-xs font-medium text-teal-600 transition-transform group-hover:translate-x-0.5">
        查看产物 →
      </span>
    </button>
  ) : null;

  return (
    <div className="relative mb-5 flex w-full flex-wrap justify-start px-3">
      <div
        className="flex max-w-[85%] min-w-0 flex-col gap-2 rounded-2xl border border-gray-100 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]"
        onMouseEnter={() => setIsShowOtherOperators(true)}
        onMouseLeave={() => setIsShowOtherOperators(false)}
      >
        {/* 工作流时间线（reasoning / tool_call / subagent_task） */}
        <MessageTimeline
          steps={timelineSteps}
          status={timelineStatus}
          interrupt={message.interrupt ?? null}
        />

        {isMultiAgent ? (
          <>
            {/* 多 agent 工作流：报告全文收进 artifact，气泡内只留 跳转按钮 + 任务总结 */}
            {artifactEntry}
            {taskSummaryPart && (
              <div className="mt-1 min-w-0 rounded-xl border border-gray-200 bg-gray-50/70 px-3.5 py-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-gray-500">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-teal-500" />
                  本次工作流任务总结
                </div>
                <div className="min-w-0 text-sm wrap-break-word text-gray-700">
                  <CustomMarkdown content={taskSummaryPart.content.text} />
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {/* 普通回答：内联正文 + 可选产物入口 */}
            {bodyText.length > 0 && <CustomMarkdown content={bodyText} />}
            {artifactEntry}
          </>
        )}
      </div>
      {renderAdditionalOperator(message.role)}
    </div>
  );
};

export default ChatMessageBubble;
