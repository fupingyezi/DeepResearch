import { deepResearchResultType, taskType } from "@/types";
import { StreamChatHandler } from "./stream-chat-handler";
import { chatWithDeepResearchProps } from "@/types";
import { useDeepResearchProcessStore } from "@/store";
import { v4 as uuidv4 } from "uuid";

/**
 * 把后端 TaskProgressPayload 折叠后的对象，映射为前端 taskType。
 *
 * - 后端字段：{ taskId, status:'started'|'running'|'completed'|'failed'|...,
 *              description?, result?, error?, message?, ...}
 * - 前端 taskType：{ id, taskId, description, status, needSearch?, searchResult?, result? }
 */
function mapTaskProgress(payload: any): taskType {
  return {
    id: payload?.taskId ?? uuidv4(),
    taskId: payload?.taskId ?? "",
    description: payload?.description ?? "",
    status: payload?.status ?? "running",
    needSearch: payload?.needSearch,
    searchResult: payload?.searchResult,
    result:
      typeof payload?.result === "string"
        ? payload.result
        : payload?.error
        ? `Error: ${payload.error}`
        : "",
  };
}

export const chatWithDeepResearch = async (
  params: chatWithDeepResearchProps
) => {
  const handler = new StreamChatHandler({
    agentType: "deep_research",
    mode: "deepResearch",
    isResume: params.isResume,
    callingMode: params.callingMode,
    inputValue: params.inputValue,
    sessionId: params.currentSessionId,
    chatSessions: params.chatSessions,
    currentMessages: params.currentMessages,
    setIsChating: params.setIsChating,
    setShouldAutoScroll: params.setShouldAutoScroll,
    addChatSession: params.addChatSession,
    setCurrentSessionId: params.setCurrentSessionId,
    setCurrentMessages: params.setCurrentMessages,
    setAbortController: params.setAbortController,
    setCurrentDeepResearchId: params.setCurrentDeepResearchId,

    // —— 深度研究 plan-mode 三开关（后端 DeerFlowClient.stream 从 metadata 读取）——
    extraMetadata: {
      is_plan_mode: true,
      subagent_enabled: true,
      agent_name: "lead-research",
    },

    // 自定义深度研究的数据处理
    onStreamData: (data, accumulatedContent) => {
      // emit_plan 第 1 帧：simple_analysis（含 researchTarget）
      if (data.type === "start_analyse" && data.payload) {
        params.setSimpleAnalysis(data.payload.simpleAnalysis);
        params.setResearchTargt(data.payload.researchTarget);
        params.setStatus("processing");
        return accumulatedContent + data.payload.simpleAnalysis;
      }

      // emit_report：最终 markdown 报告
      if (data.type === "report" && data.payload) {
        params.updateReport(data.payload);
        params.setStatus("end");
      }

      // emit_plan 第 2 帧：tasks_initial（plan 任务大纲）
      if (data.type === "tasks_initial" && data.payload) {
        params.initialTasks(data.payload);
        params.setIsOpenProcessSider(true);
      }

      // task_progress（折叠的 task_started/running/completed/...）
      // 动态 tasks：addTask 兜底新增；存在则按 taskId 就地合并 status/result。
      if (data.type === "task_update" && data.payload) {
        const mapped = mapTaskProgress(data.payload);
        // 显式打开抽屉（task 流先于 plan 抵达时也能看到）
        params.setIsOpenProcessSider(true);
        // 优先 addTask（去重 + upsert），保留 plan 中已有 description
        useDeepResearchProcessStore.getState().addTask(mapped);
      }

      // ask_clarification → human_interrupt
      if (data.type === "interrupt" && data.payload) {
        params.setInterruptRequest(data.payload);
        params.setStatus("interrupt");
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

    getDeepResearchStatus: () => {
      const { status } = useDeepResearchProcessStore.getState();

      return status;
    },
  });

  await handler.execute();
};
