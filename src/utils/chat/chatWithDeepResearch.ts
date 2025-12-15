import { deepResearchResultType } from "@/types";
import { StreamChatHandler } from "./streamChatHandler";
import { chatWithDeepResearchProps } from "@/types";
import { useDeepResearchProcessStore } from "@/store";
import { v4 as uuidv4 } from "uuid";

export const chatWithDeepResearch = async (
  params: chatWithDeepResearchProps
) => {
  const handler = new StreamChatHandler({
    apiEndpoint: "/api/chat/v1/deep_research",
    mode: "deepResearch",
    callingMode: params.callingMode,
    inputValue: params.inputValue,
    sessionId: params.currentSession,
    chatSessions: params.chatSessions,
    currentMessages: params.currentMessages,
    setIsChating: params.setIsChating,
    setShouldAutoScroll: params.setShouldAutoScroll,
    addChatSession: params.addChatSession,
    setCurrentSession: params.setCurrentSession,
    setCurrentMessages: params.setCurrentMessages,
    setAbortController: params.setAbortController,

    // 自定义深度研究的数据处理
    onStreamData: (data, accumulatedContent) => {
      if (data.type === "start_analyse" && data.payload) {
        params.setSimpleAnalysis(data.payload.simpleAnalysis);
        params.setResearchTargt(data.payload.researchTarget);
        params.setStatus("processing");
        return accumulatedContent + data.payload.simpleAnalysis;
      }

      if (data.type === "summary" && data.payload) {
        params.updateReport(data.payload);
        params.setStatus("end");
      }

      if (data.type === "tasks_initial" && data.payload) {
        params.initialTasks(data.payload);
        params.setIsOpenProcessSider(true);
      }

      if (data.type === "task_update" && data.payload) {
        params.updateTasks(data.payload);
      }

      return accumulatedContent;
    },

    // 自定义完成处理
    getDeepResearchResult: (sessionId, messageId) => {
      if (!sessionId || !messageId) return;
      const { researchTarget, tasks, report } =
        useDeepResearchProcessStore.getState();
      const tasksWithUuid = (tasks || []).map((task) => ({
        ...task,
        id: uuidv4(),
      }));
      return {
        messageId: messageId,
        sessionId: sessionId,
        researchTarget: researchTarget || "",
        tasks: tasksWithUuid,
        report: report,
      } as deepResearchResultType;
    },
  });

  await handler.execute();
};
