'use client';

import { useState } from 'react';
import {
  CheckCircleOutlined,
  LoadingOutlined,
  CaretRightOutlined,
  SearchOutlined,
  GlobalOutlined,
  ToolOutlined,
  ApartmentOutlined,
  BulbOutlined,
  CloseCircleOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { Alert } from 'antd';

import CustomMarkdown from '../markdown/custom-markdown';
import { HumanDecision } from '../process/human-decision';

import type { MessageTimelineProps, TimelineStepPart } from '@/types';

type ReasoningStep = Extract<TimelineStepPart, { type: 'reasoning' }>;
type ToolCallStep = Extract<TimelineStepPart, { type: 'tool_call' }>;
type SubagentTaskStep = Extract<TimelineStepPart, { type: 'subagent_task' }>;
type SubagentToolItem = NonNullable<SubagentTaskStep['content']['children']>[number];

const ReasoningBubble: React.FC<{ step: ReasoningStep }> = ({ step }) => {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-l-2 border-gray-200 py-1.5 pl-3">
      <div
        className="flex cursor-pointer items-center gap-2 text-gray-600 select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <CaretRightOutlined
          className={`text-xs text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <BulbOutlined className="text-amber-500" />
        <span className="text-sm font-medium">思考</span>
      </div>
      {open && (
        <div className="mt-1 ml-5 text-sm leading-relaxed text-gray-600">
          <CustomMarkdown content={step.content.text} />
        </div>
      )}
    </div>
  );
};

/** 不同工具的标签/图标 */
function getToolMeta(name: string, args: unknown): { label: string; icon: React.ReactNode } {
  const argsObj = args && typeof args === 'object' ? (args as Record<string, unknown>) : null;
  switch (name) {
    case 'web_search':
    case 'tavily_search':
    case 'duckduckgo_search':
      return {
        icon: <SearchOutlined className="text-blue-500" />,
        label: typeof argsObj?.query === 'string' ? `搜索: ${argsObj.query}` : '联网搜索',
      };
    case 'web_fetch':
    case 'fetch':
    case 'fetch_url':
      return {
        icon: <GlobalOutlined className="text-blue-500" />,
        label: typeof argsObj?.url === 'string' ? `访问: ${argsObj.url}` : '查看网页',
      };
    case 'ask_clarification':
      return {
        icon: <QuestionCircleOutlined className="text-yellow-500" />,
        label: '请求澄清',
      };
    default:
      return {
        icon: <ToolOutlined className="text-gray-500" />,
        label: name ? `调用工具: ${name}` : '工具调用',
      };
  }
}

/** 把工具调用结果归一化为搜索结果数组（兼容直接数组 / { results } / JSON 字符串） */
function extractSearchResults(toolName: string, raw: unknown): unknown[] | null {
  if (toolName !== 'web_search' && toolName !== 'tavily_search' && toolName !== 'search_web_tool') {
    return null;
  }
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as { results?: unknown };
    if (Array.isArray(obj.results)) return obj.results;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { results?: unknown }).results)
      ) {
        return (parsed as { results: unknown[] }).results;
      }
    } catch {
      return null;
    }
  }
  return null;
}

const ToolCallBubble: React.FC<{ step: ToolCallStep }> = ({ step }) => {
  const c = step.content;
  const [open, setOpen] = useState(false);
  const { label, icon } = getToolMeta(c.name, c.args);
  const isFailed = c.status === 'failed';
  const isDone = c.status === 'done';

  const renderStatus = () => {
    if (isFailed) return <CloseCircleOutlined className="text-red-500" />;
    if (isDone) return <CheckCircleOutlined className="text-green-500" />;
    return <LoadingOutlined className="text-blue-500" />;
  };

  const searchResults = extractSearchResults(c.name, c.result);

  return (
    <div className="border-l-2 border-gray-200 py-1.5 pl-3">
      <div
        className="flex cursor-pointer items-center gap-2 select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <CaretRightOutlined
          className={`text-xs text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {icon}
        <span className="flex-1 truncate text-sm text-gray-700">{label}</span>
        {renderStatus()}
      </div>

      {open && (
        <div className="mt-2 ml-5 space-y-1.5 text-xs">
          {searchResults && searchResults.length > 0 && (
            <ul className="list-none space-y-1 rounded-lg bg-[#f4f4f4] p-2">
              {searchResults.slice(0, 8).map((item, idx) => {
                const r = item as { url?: string; sourceUrl?: string; title?: string };
                return (
                  <li key={idx}>
                    <a
                      href={r.url || r.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-gray-600 hover:text-blue-600"
                    >
                      {r.title || r.url || r.sourceUrl || '未命名结果'}
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
          {!searchResults && c.args !== undefined && (
            <pre className="overflow-x-auto rounded bg-[#f4f4f4] p-2 break-all whitespace-pre-wrap text-gray-600">
              {(() => {
                try {
                  return JSON.stringify(c.args, null, 2);
                } catch {
                  return String(c.args);
                }
              })()}
            </pre>
          )}
          {c.errorMessage && <div className="text-red-500">错误：{c.errorMessage}</div>}
          {!searchResults && c.result !== undefined && (
            <pre className="max-h-60 overflow-x-auto rounded bg-[#f4f4f4] p-2 break-all whitespace-pre-wrap text-gray-600">
              {typeof c.result === 'string'
                ? c.result
                : (() => {
                    try {
                      return JSON.stringify(c.result, null, 2);
                    } catch {
                      return String(c.result);
                    }
                  })()}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

/** 子任务内的思考/规划文本，可折叠 */
const ReasoningBlock: React.FC<{ text: string }> = ({ text }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-l-2 border-amber-200 py-0.5 pl-2">
      <div
        className="flex cursor-pointer items-center gap-1.5 text-gray-500 select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <CaretRightOutlined
          className={`text-[10px] text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <BulbOutlined className="text-xs text-amber-400" />
        <span className="text-xs font-medium">思考过程</span>
      </div>
      {open && (
        <div className="mt-1 ml-4 text-xs leading-relaxed text-gray-500">
          <CustomMarkdown content={text} />
        </div>
      )}
    </div>
  );
};

const SubagentTaskBubble: React.FC<{
  step: SubagentTaskStep;
  index: number;
}> = ({ step, index }) => {
  const c = step.content;
  // 子任务默认展开，让用户能看到内部研究过程；终态后用户可手动折叠
  const [open, setOpen] = useState(true);
  const status = (c.status ?? '').toLowerCase();
  const isFailed = ['failed', 'cancelled', 'timed_out'].includes(status);
  const isDone = status === 'completed';

  const renderStatus = () => {
    if (isFailed) return <CloseCircleOutlined className="text-red-500" />;
    if (isDone) return <CheckCircleOutlined className="text-green-500" />;
    return <LoadingOutlined className="text-blue-500" />;
  };

  const children = c.children ?? [];
  const hasChildren = children.length > 0;
  const structured = c.structured;

  return (
    <div className="border-l-2 border-purple-200 py-1.5 pl-3">
      <div
        className="flex cursor-pointer items-center gap-2 select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <CaretRightOutlined
          className={`text-xs text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <ApartmentOutlined className="text-purple-500" />
        <span className="flex-1 truncate text-sm text-gray-700">
          {c.description || `子任务 ${index + 1}`}
        </span>
        {hasChildren && (
          <span className="shrink-0 text-xs text-gray-400">{children.length} 步</span>
        )}
        {renderStatus()}
      </div>

      {open && (
        <div className="mt-2 ml-5 space-y-2">
          {/* 思考/规划文本（可折叠） */}
          {c.reasoning && <ReasoningBlock text={c.reasoning} />}

          {/* 子工具调用按时序展开 */}
          {hasChildren && (
            <div className="flex flex-col gap-1">
              {children.map((item) => (
                <SubagentToolCallRow key={item.id} item={item} />
              ))}
            </div>
          )}

          {/* 结构化报告（completed 后） */}
          {structured && (
            <div className="rounded-lg border border-purple-100 bg-purple-50 p-2 text-xs">
              <div className="mb-1 font-semibold text-purple-700">摘要</div>
              <div className="mb-2 text-gray-700">{structured.summary}</div>
              {structured.keyFindings?.length > 0 && (
                <>
                  <div className="mb-1 font-semibold text-purple-700">
                    关键发现（{structured.keyFindings.length}）
                  </div>
                  <ul className="mb-2 list-inside list-disc space-y-0.5 text-gray-700">
                    {structured.keyFindings.slice(0, 6).map((kf, i) => (
                      <li key={i}>{kf.point}</li>
                    ))}
                  </ul>
                </>
              )}
              {structured.sources?.length > 0 && (
                <>
                  <div className="mb-1 font-semibold text-purple-700">
                    来源（{structured.sources.length}）
                  </div>
                  <ul className="list-none space-y-0.5 text-gray-600">
                    {structured.sources.slice(0, 6).map((s, i) => (
                      <li key={i} className="truncate">
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-blue-600"
                        >
                          [{i}] {s.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {/* fallback：没有 structured 时展示原文 result */}
          {!structured && c.result && (
            <div className="text-sm text-gray-700">
              <CustomMarkdown content={c.result} />
            </div>
          )}

          {c.error && <div className="text-sm text-red-500">错误：{c.error}</div>}
        </div>
      )}
    </div>
  );
};

/** 嵌套在 subagent 卡片里的单条子工具调用 */
const SubagentToolCallRow: React.FC<{ item: SubagentToolItem }> = ({ item }) => {
  const [open, setOpen] = useState(false);
  const { label, icon } = getToolMeta(item.name, item.args);
  const isFailed = item.status === 'failed';
  const isDone = item.status === 'done';

  const renderStatus = () => {
    if (isFailed) return <CloseCircleOutlined className="text-xs text-red-500" />;
    if (isDone) return <CheckCircleOutlined className="text-xs text-green-500" />;
    return <LoadingOutlined className="text-xs text-blue-500" />;
  };

  const searchResults = extractSearchResults(item.name, item.result);

  return (
    <div className="border-l-2 border-gray-100 py-0.5 pl-2">
      <div
        className="flex cursor-pointer items-center gap-1.5 select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <CaretRightOutlined
          className={`text-[10px] text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="shrink-0">{icon}</span>
        <span className="flex-1 truncate text-xs text-gray-600">{label}</span>
        {renderStatus()}
      </div>
      {open && (
        <div className="mt-1 ml-4 space-y-1 text-xs">
          {searchResults && searchResults.length > 0 && (
            <ul className="list-none space-y-0.5 rounded bg-[#f4f4f4] p-1.5">
              {searchResults.slice(0, 6).map((entry, i) => {
                const r = entry as { url?: string; sourceUrl?: string; title?: string };
                return (
                  <li key={i} className="truncate">
                    <a
                      href={r.url || r.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-600 hover:text-blue-600"
                    >
                      {r.title || r.url || r.sourceUrl || '未命名'}
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
          {!searchResults && item.args !== undefined && (
            <pre className="max-h-24 overflow-x-auto rounded bg-[#f4f4f4] p-1.5 break-all whitespace-pre-wrap text-gray-600">
              {(() => {
                try {
                  return JSON.stringify(item.args, null, 2);
                } catch {
                  return String(item.args);
                }
              })()}
            </pre>
          )}
          {item.errorMessage && <div className="text-red-500">错误：{item.errorMessage}</div>}
        </div>
      )}
    </div>
  );
};

const MessageTimeline: React.FC<MessageTimelineProps> = ({ steps, status, interrupt }) => {
  const hasSteps = steps.length > 0;
  const showInterrupt = status === 'interrupt' && !!interrupt;

  if (!hasSteps && !showInterrupt) return null;

  let subagentCounter = 0;

  return (
    <div className="my-2 rounded-xl border border-gray-200 bg-white/70 backdrop-blur-sm">
      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        {status === 'processing' && <LoadingOutlined className="text-blue-500" />}
        {status === 'end' && <CheckCircleOutlined className="text-green-500" />}
        {status === 'failed' && <CloseCircleOutlined className="text-red-500" />}
        <span className="text-sm font-medium text-gray-700">
          {status === 'processing' && '正在思考…'}
          {status === 'end' && '已完成'}
          {status === 'interrupt' && '等待您的确认'}
          {status === 'failed' && '任务失败'}
          {status === 'idle' && '已就绪'}
        </span>
      </div>

      <div className="flex flex-col gap-1 px-3 py-2">
        {steps.map((step) => {
          if (step.type === 'reasoning') {
            return <ReasoningBubble key={step.partId} step={step} />;
          }
          if (step.type === 'tool_call') {
            return <ToolCallBubble key={step.partId} step={step} />;
          }
          if (step.type === 'subagent_task') {
            return <SubagentTaskBubble key={step.partId} step={step} index={subagentCounter++} />;
          }
          return null;
        })}

        {showInterrupt && interrupt && (
          <div className="mt-1 rounded-lg bg-yellow-50 p-2">
            <Alert
              type="info"
              message={interrupt.question || '请确认是否继续？'}
              showIcon
              className="mb-2!"
            />
            <HumanDecision />
          </div>
        )}
      </div>
    </div>
  );
};

export default MessageTimeline;
