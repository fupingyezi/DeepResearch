"use client";

import { useState } from "react";
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
} from "@ant-design/icons";
import { Alert } from "antd";

import CustomMarkdown from "../markdown/custom-markdown";
import { HumanDecision } from "../process/human-decision";

import type { CoTStep, MessageTimeline as MessageTimelineType } from "@/types";

interface Props {
  timeline?: MessageTimelineType;
}

/* -------------------------------------------------------------------------- */
/*  Step 渲染                                                                  */
/* -------------------------------------------------------------------------- */

const ReasoningStep: React.FC<{ step: Extract<CoTStep, { kind: "reasoning" }> }> = ({
  step,
}) => {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-l-2 border-gray-200 pl-3 py-1.5">
      <div
        className="flex items-center gap-2 cursor-pointer select-none text-gray-600"
        onClick={() => setOpen((v) => !v)}
      >
        <CaretRightOutlined
          className={`text-xs text-gray-400 transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <BulbOutlined className="text-amber-500" />
        <span className="text-sm font-medium">思考</span>
      </div>
      {open && (
        <div className="mt-1 ml-5 text-sm text-gray-600 leading-relaxed">
          <CustomMarkdown content={step.text} />
        </div>
      )}
    </div>
  );
};

/** 不同工具的标签/图标 */
function getToolMeta(name: string, args: any): { label: string; icon: React.ReactNode } {
  switch (name) {
    case "web_search":
    case "tavily_search":
    case "duckduckgo_search":
      return {
        icon: <SearchOutlined className="text-blue-500" />,
        label:
          typeof args?.query === "string" ? `搜索: ${args.query}` : "联网搜索",
      };
    case "web_fetch":
    case "fetch":
    case "fetch_url":
      return {
        icon: <GlobalOutlined className="text-blue-500" />,
        label:
          typeof args?.url === "string" ? `访问: ${args.url}` : "查看网页",
      };
    case "ask_clarification":
      return {
        icon: <QuestionCircleOutlined className="text-yellow-500" />,
        label: "请求澄清",
      };
    default:
      return {
        icon: <ToolOutlined className="text-gray-500" />,
        label: name ? `调用工具: ${name}` : "工具调用",
      };
  }
}

const ToolCallStep: React.FC<{
  step: Extract<CoTStep, { kind: "tool_call" }>;
}> = ({ step }) => {
  const [open, setOpen] = useState(false);
  const { label, icon } = getToolMeta(step.name, step.args);
  const isFailed = step.status === "failed";
  const isDone = step.status === "done";

  const renderStatus = () => {
    if (isFailed) return <CloseCircleOutlined className="text-red-500" />;
    if (isDone) return <CheckCircleOutlined className="text-green-500" />;
    return <LoadingOutlined className="text-blue-500" />;
  };

  // 提取搜索结果列表（如果是搜索工具）
  const searchResults = (() => {
    if (step.name !== "web_search" && step.name !== "tavily_search") return null;
    const r = step.result;
    if (Array.isArray(r)) return r;
    if (Array.isArray(r?.results)) return r.results;
    return null;
  })();

  return (
    <div className="border-l-2 border-gray-200 pl-3 py-1.5">
      <div
        className="flex items-center gap-2 cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <CaretRightOutlined
          className={`text-xs text-gray-400 transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        {icon}
        <span className="text-sm text-gray-700 truncate flex-1">{label}</span>
        {renderStatus()}
      </div>

      {open && (
        <div className="mt-2 ml-5 text-xs space-y-1.5">
          {searchResults && searchResults.length > 0 && (
            <ul className="bg-[#f4f4f4] rounded-lg p-2 space-y-1 list-none">
              {searchResults.slice(0, 8).map((item: any, idx: number) => (
                <li key={idx}>
                  <a
                    href={item.url || item.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-gray-600 hover:text-blue-600 truncate"
                  >
                    {item.title || item.url || item.sourceUrl || "未命名结果"}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {!searchResults && step.args && (
            <pre className="bg-[#f4f4f4] text-gray-600 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
              {(() => {
                try {
                  return JSON.stringify(step.args, null, 2);
                } catch {
                  return String(step.args);
                }
              })()}
            </pre>
          )}
          {step.errorMessage && (
            <div className="text-red-500">错误：{step.errorMessage}</div>
          )}
          {!searchResults && step.result !== undefined && (
            <pre className="bg-[#f4f4f4] text-gray-600 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-60">
              {typeof step.result === "string"
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

const SubagentTaskStep: React.FC<{
  step: Extract<CoTStep, { kind: "subagent_task" }>;
  index: number;
}> = ({ step, index }) => {
  const [open, setOpen] = useState(false);
  const isFailed = ["failed", "cancelled", "timed_out"].includes(step.status);
  const isDone = step.status === "completed";

  const renderStatus = () => {
    if (isFailed) return <CloseCircleOutlined className="text-red-500" />;
    if (isDone) return <CheckCircleOutlined className="text-green-500" />;
    return <LoadingOutlined className="text-blue-500" />;
  };

  return (
    <div className="border-l-2 border-gray-200 pl-3 py-1.5">
      <div
        className="flex items-center gap-2 cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <CaretRightOutlined
          className={`text-xs text-gray-400 transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <ApartmentOutlined className="text-purple-500" />
        <span className="text-sm text-gray-700 truncate flex-1">
          {step.description || `子任务 ${index + 1}`}
        </span>
        {renderStatus()}
      </div>

      {open && (step.result || step.error) && (
        <div className="mt-2 ml-5 text-sm">
          {step.result && (
            <div className="text-gray-700">
              <CustomMarkdown content={step.result} />
            </div>
          )}
          {step.error && <div className="text-red-500">错误：{step.error}</div>}
        </div>
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/*  主组件                                                                     */
/* -------------------------------------------------------------------------- */

const MessageTimeline: React.FC<Props> = ({ timeline }) => {
  if (!timeline) return null;
  const { steps, status, interrupt } = timeline;

  const hasSteps = steps.length > 0;
  const showInterrupt = status === "interrupt" && interrupt;

  if (!hasSteps && !showInterrupt) return null;

  let subagentCounter = 0;

  return (
    <div className="my-2 rounded-xl border border-gray-200 bg-white/70 backdrop-blur-sm">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
        {status === "processing" && <LoadingOutlined className="text-blue-500" />}
        {status === "end" && <CheckCircleOutlined className="text-green-500" />}
        {status === "failed" && <CloseCircleOutlined className="text-red-500" />}
        <span className="text-sm font-medium text-gray-700">
          {status === "processing" && "正在思考…"}
          {status === "end" && "已完成"}
          {status === "interrupt" && "等待您的确认"}
          {status === "failed" && "任务失败"}
          {status === "idle" && "已就绪"}
        </span>
      </div>

      <div className="px-3 py-2 flex flex-col gap-1">
        {steps.map((step) => {
          if (step.kind === "reasoning") {
            return <ReasoningStep key={step.id} step={step} />;
          }
          if (step.kind === "tool_call") {
            return <ToolCallStep key={step.id} step={step} />;
          }
          if (step.kind === "subagent_task") {
            return (
              <SubagentTaskStep
                key={step.id}
                step={step}
                index={subagentCounter++}
              />
            );
          }
          return null;
        })}

        {showInterrupt && (
          <div className="rounded-lg bg-yellow-50 p-2 mt-1">
            <Alert
              type="info"
              message={interrupt!.question || "请确认是否继续？"}
              showIcon
              className="!mb-2"
            />
            <HumanDecision />
          </div>
        )}
      </div>
    </div>
  );
};

export default MessageTimeline;
