'use client';

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
import { hasMeaningfulArgs } from '@/utils/common';
import { useDisclosure } from '@/hooks';

type ReasoningStep = Extract<TimelineStepPart, { type: 'reasoning' }>;
type ToolCallStep = Extract<TimelineStepPart, { type: 'tool_call' }>;
type SubagentTaskStep = Extract<TimelineStepPart, { type: 'subagent_task' }>;
type SubagentToolItem = NonNullable<SubagentTaskStep['content']['children']>[number];

type ToolCallStatus = 'running' | 'done' | 'failed';

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

/** 把工具调用结果归一化为搜索结果数组（兼容直接数组 / { results } / JSON 字符串 / search_web_tool 文本格式） */
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
      // fall through to text-format parsing
    }
    // search_web_tool 文本格式：`结果 N: 标题: xxx 来源: <URL> 内容: ... ---`
    const items = parseSearchWebToolText(raw);
    if (items.length > 0) return items;
  }
  return null;
}

/** 解析 search_web_tool 的拼接文本结果为 `{ title, url }[]`。 */
function parseSearchWebToolText(text: string): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  const re = /标题:\s*([^\n]+?)\s*\n\s*来源:\s*(https?:\/\/[^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const title = m[1].trim();
    const url = m[2].trim();
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url });
  }
  return out;
}

/** 子工具调用是否「有意义」：args 非空对象 或 result 已到达。 */
function hasMeaningfulSubagentToolCall(item: SubagentToolItem): boolean {
  if (item.result !== undefined) return true;
  if (item.errorMessage) return true;
  return hasMeaningfulArgs(item.args);
}

/** tool_call status → 状态图标，sizeClass 控制文本尺寸（小卡片用 text-xs） */
function renderStatusIcon(status: ToolCallStatus | undefined, sizeClass = ''): React.ReactNode {
  if (status === 'failed') return <CloseCircleOutlined className={`${sizeClass} text-red-500`} />;
  if (status === 'done') return <CheckCircleOutlined className={`${sizeClass} text-green-500`} />;
  return <LoadingOutlined className={`${sizeClass} text-blue-500`} />;
}

/** 把 args 对象安全格式化为缩进 JSON；失败时回退到 String() */
function safeStringifyArgs(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

const ReasoningBubble: React.FC<{ step: ReasoningStep }> = ({ step }) => {
  const { isOpen, toggle } = useDisclosure(true);
  return (
    <div className="min-w-0 border-l-2 border-amber-200 py-1.5 pl-3">
      <div
        className="flex cursor-pointer items-center gap-2 text-gray-600 select-none"
        onClick={toggle}
      >
        <CaretRightOutlined
          className={`text-xs text-gray-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}
        />
        <BulbOutlined className="text-amber-500" />
        <span className="text-sm font-medium">思考</span>
      </div>
      {isOpen && (
        <div className="mt-1 ml-5 min-w-0 overflow-hidden text-sm leading-relaxed wrap-break-word text-gray-600">
          <CustomMarkdown content={step.content.text} />
        </div>
      )}
    </div>
  );
};

const ToolCallBubble: React.FC<{ step: ToolCallStep }> = ({ step }) => {
  const c = step.content;
  const { isOpen, toggle } = useDisclosure(false);
  const { label, icon } = getToolMeta(c.name, c.args);

  const searchResults = extractSearchResults(c.name, c.result);

  return (
    <div className="min-w-0 border-l-2 border-sky-200 py-1.5 pl-3">
      <div className="flex min-w-0 cursor-pointer items-center gap-2 select-none" onClick={toggle}>
        <CaretRightOutlined
          className={`shrink-0 text-xs text-gray-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}
        />
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-gray-700">{label}</span>
        <span className="shrink-0">{renderStatusIcon(c.status)}</span>
      </div>

      {isOpen && (
        <div className="mt-2 ml-5 min-w-0 space-y-1.5 text-xs">
          {searchResults && searchResults.length > 0 && (
            <ul className="list-none space-y-1 rounded-lg border border-gray-100 bg-gray-50 p-2">
              {searchResults.slice(0, 8).map((item, idx) => {
                const r = item as { url?: string; sourceUrl?: string; title?: string };
                return (
                  <li key={idx} className="min-w-0">
                    <a
                      href={r.url || r.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 truncate text-gray-600 transition-colors hover:text-teal-600"
                    >
                      <GlobalOutlined className="shrink-0 text-[10px] text-gray-400" />
                      <span className="truncate">
                        {r.title || r.url || r.sourceUrl || '未命名结果'}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
          {!searchResults && c.args !== undefined && (
            <pre className="scrollbar-slim max-h-48 w-full min-w-0 overflow-auto rounded-lg border border-gray-100 bg-gray-50 p-2.5 text-[12px] wrap-break-word whitespace-pre-wrap text-gray-600">
              {safeStringifyArgs(c.args)}
            </pre>
          )}
          {c.errorMessage && <div className="wrap-break-word text-red-500">错误：{c.errorMessage}</div>}
          {!searchResults && c.result !== undefined && (
            <pre className="scrollbar-slim max-h-60 w-full min-w-0 overflow-auto rounded-lg border border-gray-100 bg-gray-50 p-2.5 text-[12px] wrap-break-word whitespace-pre-wrap text-gray-600">
              {typeof c.result === 'string' ? c.result : safeStringifyArgs(c.result)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

/** 子任务内的思考/规划文本，可折叠 */
const ReasoningBlock: React.FC<{ text: string }> = ({ text }) => {
  const { isOpen, toggle } = useDisclosure(false);
  return (
    <div className="min-w-0 border-l-2 border-amber-200 py-0.5 pl-2">
      <div
        className="flex min-w-0 cursor-pointer items-center gap-1.5 text-gray-500 select-none"
        onClick={toggle}
      >
        <CaretRightOutlined
          className={`shrink-0 text-[10px] text-gray-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}
        />
        <BulbOutlined className="text-xs text-amber-400" />
        <span className="text-xs font-medium">思考过程</span>
      </div>
      {isOpen && (
        <div className="mt-1 ml-4 min-w-0 overflow-hidden text-xs leading-relaxed wrap-break-word text-gray-500">
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
  const { isOpen, toggle } = useDisclosure(true);
  const status = (c.status ?? '').toLowerCase();
  const isFailed = ['failed', 'cancelled', 'timed_out'].includes(status);
  const isDone = status === 'completed';
  const taskStatus: ToolCallStatus = isFailed ? 'failed' : isDone ? 'done' : 'running';

  const children = (c.children ?? []).filter(hasMeaningfulSubagentToolCall);
  const hasChildren = children.length > 0;
  const structured = c.structured;

  return (
    <div className="min-w-0 border-l-2 border-purple-200 py-1.5 pl-3">
      <div className="flex min-w-0 cursor-pointer items-center gap-2 select-none" onClick={toggle}>
        <CaretRightOutlined
          className={`shrink-0 text-xs text-gray-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}
        />
        <ApartmentOutlined className="shrink-0 text-purple-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-700">
          {c.description || `子任务 ${index + 1}`}
        </span>
        {hasChildren && (
          <span className="shrink-0 rounded-full bg-purple-50 px-1.5 py-0.5 text-xs text-purple-500">
            {children.length} 步
          </span>
        )}
        <span className="shrink-0">{renderStatusIcon(taskStatus)}</span>
      </div>

      {isOpen && (
        <div className="mt-2 ml-5 min-w-0 space-y-2">
          {/* 思考/规划文本（可折叠） */}
          {c.reasoning && <ReasoningBlock text={c.reasoning} />}

          {/* 子工具调用按时序展开 */}
          {hasChildren && (
            <div className="flex min-w-0 flex-col gap-1">
              {children.map((item) => (
                <SubagentToolCallRow key={item.id} item={item} />
              ))}
            </div>
          )}

          {/* 结构化报告（completed 后） */}
          {structured && (
            <div className="min-w-0 rounded-xl border border-purple-100 bg-purple-50/60 p-3 text-xs">
              <div className="mb-1 font-semibold text-purple-700">摘要</div>
              <div className="mb-2 wrap-break-word text-gray-700">{structured.summary}</div>
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
            <div className="min-w-0 overflow-hidden text-sm wrap-break-word text-gray-700">
              <CustomMarkdown content={c.result} />
            </div>
          )}

          {c.error && <div className="text-sm wrap-break-word text-red-500">错误：{c.error}</div>}
        </div>
      )}
    </div>
  );
};

/** 嵌套在 subagent 卡片里的单条子工具调用 */
const SubagentToolCallRow: React.FC<{ item: SubagentToolItem }> = ({ item }) => {
  // ghost 兜底：args 与 result 都为空的「幽灵调用」直接不渲染，
  // 防止 timeline 里出现可展开但内容空白的工具行。
  const isMeaningful = hasMeaningfulSubagentToolCall(item);
  const { isOpen, toggle } = useDisclosure(false);
  if (!isMeaningful) return null;
  const { label, icon } = getToolMeta(item.name, item.args);

  const searchResults = extractSearchResults(item.name, item.result);

  return (
    <div className="min-w-0 border-l-2 border-gray-100 py-0.5 pl-2">
      <div
        className="flex min-w-0 cursor-pointer items-center gap-1.5 select-none"
        onClick={toggle}
      >
        <CaretRightOutlined
          className={`shrink-0 text-[10px] text-gray-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}
        />
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-gray-600">{label}</span>
        <span className="shrink-0">{renderStatusIcon(item.status, 'text-xs')}</span>
      </div>
      {isOpen && (
        <div className="mt-1 ml-4 min-w-0 space-y-1 text-xs">
          {searchResults && searchResults.length > 0 && (
            <ul className="list-none space-y-0.5 rounded-lg border border-gray-100 bg-gray-50 p-1.5">
              {searchResults.slice(0, 6).map((entry, i) => {
                const r = entry as { url?: string; sourceUrl?: string; title?: string };
                return (
                  <li key={i} className="min-w-0 truncate">
                    <a
                      href={r.url || r.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-600 transition-colors hover:text-teal-600"
                    >
                      {r.title || r.url || r.sourceUrl || '未命名'}
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
          {hasMeaningfulArgs(item.args) && (
            <pre className="scrollbar-slim max-h-24 w-full min-w-0 overflow-auto rounded-lg border border-gray-100 bg-gray-50 p-2 text-[12px] wrap-break-word whitespace-pre-wrap text-gray-600">
              {safeStringifyArgs(item.args)}
            </pre>
          )}
          {item.errorMessage && (
            <div className="wrap-break-word text-red-500">错误：{item.errorMessage}</div>
          )}
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
    <div className="my-2 min-w-0 overflow-hidden rounded-2xl border border-gray-200 bg-white/80 shadow-[0_1px_2px_rgba(16,24,40,0.04)] backdrop-blur-sm">
      <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50/60 px-3.5 py-2.5">
        {status === 'processing' && <LoadingOutlined className="text-teal-500" />}
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

      <div className="flex min-w-0 flex-col gap-1 px-3.5 py-2.5">
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
              message={interrupt.question || '需要你的回答'}
              showIcon
              className="mb-2!"
            />
            <HumanDecision question={interrupt.question} details={interrupt.details} />
          </div>
        )}
      </div>
    </div>
  );
};

export default MessageTimeline;
