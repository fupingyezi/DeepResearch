"use client";

import { LoadingOutlined } from "@ant-design/icons";
import { Title } from "./Title";
import { TaskProcessingItem } from "./TaskProcessingItem";
import { Report } from "./Report";
import { ProcessHeader } from "./ProcessHeader";

import useDeepResearchProcessStore from "@/store/deepResearchProcessStore";
import { useState, useEffect } from "react";

const DeepResearchProcess = () => {
  const {
    isOpenProcessSider,
    researchTarget,
    tasks,
    report,
    setIsOpenProcessSider,
  } = useDeepResearchProcessStore();
  const [selectedTab, setSelectedTab] = useState<"process" | "report">(
    "process"
  );

  useEffect(() => {
    if (selectedTab === "process") {
      setSelectedTab("report");
    }
  }, [report]);

  if (!isOpenProcessSider) return null;

  return (
    <div className="h-screen w-6xl px-4 flex flex-col overflow-y-scroll overflow-x-hidden relative border-l-2 border-[#f3f3f3]">
      {/* header */}
      <ProcessHeader
        selectedTab={selectedTab}
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
                  isShow={index === 0 || tasks[index - 1].result !== ""}
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
        </>
      )}

      {/* report */}
      {report && selectedTab === "report" && <Report report={report} />}
    </div>
  );
};

export default DeepResearchProcess;
