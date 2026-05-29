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

import type { CoTStep, MessageTimeline as MessageTimelineType } from '@/types';

interface Props {
  timeline?: MessageTimelineType;
}

const ReasoningStep: React.FC<{ step: Extract<CoTStep, { kind: 'reasoning' }> }> = ({ step }) => {
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
          <CustomMarkdown content={step.text} />
        </div>
      )}
    </div>
  );
};

/** 不同工具的标签/图标 */
function getToolMeta(name: string, args: any): { label: string; icon: React.ReactNode } {
  switch (name) {
    case 'web_search':
    case 'tavily_search':
    case 'duckduckgo_search':
      return {
        icon: <SearchOutlined className="text-blue-500" />,
        label: typeof args?.query === 'string' ? `搜索: ${args.query}` : '联网搜索',
      };
    case 'web_fetch':
    case 'fetch':
    case 'fetch_url':
      return {
        icon: <GlobalOutlined className="text-blue-500" />,
        label: typeof args?.url === 'string' ? `访问: ${args.url}` : '查看网页',
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

const ToolCallStep: React.FC<{
  step: Extract<CoTStep, { kind: 'tool_call' }>;
}> = ({ step }) => {
  const [open, setOpen] = useState(false);
  const { label, icon } = getToolMeta(step.name, step.args);
  const isFailed = step.status === 'failed';
  const isDone = step.status === 'done';

  const renderStatus = () => {
    if (isFailed) return <CloseCircleOutlined className="text-red-500" />;
    if (isDone) return <CheckCircleOutlined className="text-green-500" />;
    return <LoadingOutlined className="text-blue-500" />;
  };

  // 提取搜索结果列表（如果是搜索工具）
  const searchResults = (() => {
    if (step.name !== 'web_search' && step.name !== 'tavily_search') return null;
    const r = step.result;
    if (Array.isArray(r)) return r;
    if (Array.isArray(r?.results)) return r.results;
    return null;
  })();

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
              {searchResults.slice(0, 8).map((item: any, idx: number) => (
                <li key={idx}>
                  <a
                    href={item.url || item.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block truncate text-gray-600 hover:text-blue-600"
                  >
                    {item.title || item.url || item.sourceUrl || '未命名结果'}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {!searchResults && step.args && (
            <pre className="overflow-x-auto rounded bg-[#f4f4f4] p-2 break-all whitespace-pre-wrap text-gray-600">
              {(() => {
                try {
                  return JSON.stringify(step.args, null, 2);
                } catch {
                  return String(step.args);
                }
              })()}
            </pre>
          )}
          {step.errorMessage && <div className="text-red-500">错误：{step.errorMessage}</div>}
          {!searchResults && step.result !== undefined && (
            <pre className="max-h-60 overflow-x-auto rounded bg-[#f4f4f4] p-2 break-all whitespace-pre-wrap text-gray-600">
              {typeof step.result === 'string'
                ? step.result
                : (() => {
                    try {
                      return JSON.stringify(step.result, null, 2);
                    } catch {
                      return String(step.result);
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

const SubagentTaskStep: React.FC<{
  step: Extract<CoTStep, { kind: 'subagent_task' }>;
  index: number;
}> = ({ step, index }) => {
  // 子任务默认展开，让用户能看到内部研究过程；终态后用户可手动折叠
  const [open, setOpen] = useState(true);
  const status = (step.status ?? '').toLowerCase();
  const isFailed = ['failed', 'cancelled', 'timed_out'].includes(status);
  const isDone = status === 'completed';

  const renderStatus = () => {
    if (isFailed) return <CloseCircleOutlined className="text-red-500" />;
    if (isDone) return <CheckCircleOutlined className="text-green-500" />;
    return <LoadingOutlined className="text-blue-500" />;
  };

  const children = step.children ?? [];
  const hasChildren = children.length > 0;
  const structured = step.structured;

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
          {step.description || `子任务 ${index + 1}`}
        </span>
        {hasChildren && (
          <span className="shrink-0 text-xs text-gray-400">{children.length} 步</span>
        )}
        {renderStatus()}
      </div>

      {open && (
        <div className="mt-2 ml-5 space-y-2">
          {/* 思考/规划文本（可折叠） */}
          {step.reasoning && <ReasoningBlock text={step.reasoning} />}

          {/* 子工具调用按时序展开 */}
          {hasChildren && (
            <div className="flex flex-col gap-1">
              {children.map((c) => (
                <SubagentToolCallRow key={c.id} item={c} />
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
          {!structured && step.result && (
            <div className="text-sm text-gray-700">
              <CustomMarkdown content={step.result} />
            </div>
          )}

          {step.error && <div className="text-sm text-red-500">错误：{step.error}</div>}
        </div>
      )}
    </div>
  );
};

/** 嵌套在 subagent 卡片里的单条子工具调用 */
const SubagentToolCallRow: React.FC<{
  item: NonNullable<Extract<CoTStep, { kind: 'subagent_task' }>['children']>[number];
}> = ({ item }) => {
  const [open, setOpen] = useState(false);
  const { label, icon } = getToolMeta(item.name, item.args);
  const isFailed = item.status === 'failed';
  const isDone = item.status === 'done';

  const renderStatus = () => {
    if (isFailed) return <CloseCircleOutlined className="text-xs text-red-500" />;
    if (isDone) return <CheckCircleOutlined className="text-xs text-green-500" />;
    return <LoadingOutlined className="text-xs text-blue-500" />;
  };

  // 复用 ToolCallStep 的搜索结果抽取
  const searchResults = (() => {
    if (
      item.name !== 'web_search' &&
      item.name !== 'tavily_search' &&
      item.name !== 'search_web_tool'
    )
      return null;
    const r = item.result;
    if (Array.isArray(r)) return r;
    if (Array.isArray(r?.results)) return r.results;
    // 后端 web_search 工具有可能返回 JSON 字符串
    if (typeof r === 'string') {
      try {
        const parsed = JSON.parse(r);
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed?.results)) return parsed.results;
      } catch {
        return null;
      }
    }
    return null;
  })();

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
              {searchResults.slice(0, 6).map((r: any, i: number) => (
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
              ))}
            </ul>
          )}
          {!searchResults && item.args && (
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

const MessageTimeline: React.FC<Props> = ({ timeline }) => {
  if (!timeline) return null;
  const { steps, status, interrupt } = timeline;

  const hasSteps = steps.length > 0;
  const showInterrupt = status === 'interrupt' && interrupt;

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
          if (step.kind === 'reasoning') {
            return <ReasoningStep key={step.id} step={step} />;
          }
          if (step.kind === 'tool_call') {
            return <ToolCallStep key={step.id} step={step} />;
          }
          if (step.kind === 'subagent_task') {
            return <SubagentTaskStep key={step.id} step={step} index={subagentCounter++} />;
          }
          return null;
        })}

        {showInterrupt && (
          <div className="mt-1 rounded-lg bg-yellow-50 p-2">
            <Alert
              type="info"
              message={interrupt!.question || '请确认是否继续？'}
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
