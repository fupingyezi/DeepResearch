"use client";

import { LoadingOutlined } from "@ant-design/icons";
import { Title } from "./title";
import { TaskProcessingItem } from "./task-processing-item";
import { Report } from "./report";
import { ProcessHeader } from "./process-header";
import { HumanDecision } from "./human-decision";

import useDeepResearchProcessStore from "@/store/deep-research-process-store";
import { useState, useEffect } from "react";

const DeepResearchProcess = () => {
  // 精细订阅：避免每次 store 任意字段变化都让本组件重渲染（SSE task_update
  // 高频触发 isOpenProcessSider/tasks 等更新，下面挂的 effect 会被反复唤醒）。
  const isOpenProcessSider = useDeepResearchProcessStore(
    (s) => s.isOpenProcessSider
  );
  const setIsOpenProcessSider = useDeepResearchProcessStore(
    (s) => s.setIsOpenProcessSider
  );
  const researchTarget = useDeepResearchProcessStore((s) => s.researchTarget);
  const tasks = useDeepResearchProcessStore((s) => s.tasks);
  const report = useDeepResearchProcessStore((s) => s.report);
  const status = useDeepResearchProcessStore((s) => s.status);

  const [selectedTab, setSelectedTab] = useState<"process" | "report">(
    "process"
  );

  // report 第一次出现时自动切换到「报告」Tab。
  // 之前 deps 漏写 selectedTab，effect 在每次 report 引用变化时都会跑，
  // 高频 SSE 写 store 时容易把 selectedTab 反复设置回 "report" 形成 setState 抖动。
  useEffect(() => {
    if (selectedTab === "process" && report) {
      setSelectedTab("report");
    }
  }, [report, selectedTab]);

  // 抽屉切换/重置时，若 report 已被清空则回到 process Tab。
  // 之前 deps 只有 isOpenProcessSider，且体内同时读 selectedTab+report，
  // 是 React 经典 deps lint 漏配置——本质上只关心抽屉打开瞬间，
  // 而不是 report 任意变化。这里改用 isOpenProcessSider+report 两个真实依赖，
  // 但加显式条件 `!report` 保证不会跟上面那条 effect 形成"打 report 后立刻被切回 process"的回路。
  useEffect(() => {
    if (isOpenProcessSider && !report && selectedTab === "report") {
      setSelectedTab("process");
    }
  }, [isOpenProcessSider, report, selectedTab]);

  if (!isOpenProcessSider) return null;

  return (
    <div className="h-screen w-6xl px-4 flex flex-col overflow-y-scroll overflow-x-hidden relative border-l-2 border-[#f3f3f3]">
      {/* header */}
      <ProcessHeader
        selectedTab={selectedTab}
        report={report}
        setSelectedTab={setSelectedTab}
        setIsOpen={setIsOpenProcessSider}
        researchTarget={researchTarget}
      />

      {selectedTab === "process" && (
        <>
          {/* outline */}
          {tasks.length !== 0 && (
            <div className="w-full mt-4 p-4 space-y-2 bg-[#f4f4f4] rounded-xl">
              <div className="flex">
                <div>
                  <Title title="🔍生成大纲并按需搜索互联网公开信息" />
                  <ul className="mt-1.5 space-y-1.5 pl-8">
                    {tasks.map((task) => (
                      <li
                        key={task.id}
                        className="text-sm text-gray-600 list-item list-disc marker:text-gray-400"
                      >
                        {task.description}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="flex">
                <Title title="💡根据搜索到的内容进行分析" />
              </div>

              <div className="flex">
                <Title title="📄生成分析研究报告" />
              </div>
            </div>
          )}

          {/* research */}
          {tasks.length !== 0 && (
            <div className="w-full flex flex-col">
              {tasks.map((task, index) => (
                <TaskProcessingItem
                  key={task.id}
                  task={task}
                  isShow={
                    (status !== "interrupt" &&
                      (index === 0 || tasks[index - 1].result !== "")) ||
                    task.result !== ""
                  }
                />
              ))}
              {tasks.every((task) => task.result) && !report && (
                <div className="w-full flex items-center mt-3">
                  <LoadingOutlined />
                  <Title title="正在生成最终报告"></Title>
                </div>
              )}
            </div>
          )}
          {status === "interrupt" && <HumanDecision />}
        </>
      )}

      {/* report */}
      {report && selectedTab === "report" && <Report report={report} />}
    </div>
  );
};

export default DeepResearchProcess;
