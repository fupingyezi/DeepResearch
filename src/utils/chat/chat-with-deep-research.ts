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
  const hasResult = typeof payload?.result === 'string' && payload.result.length > 0;
  const hasError = typeof payload?.error === 'string' && payload.error.length > 0;
  const result = hasResult ? payload.result : hasError ? `Error: ${payload.error}` : undefined;

  return {
    id: payload?.taskId ?? uuidv4(),
    taskId: payload?.taskId ?? '',
    // description/needSearch/searchResult/result：缺省即 undefined，避免覆盖已有值
    description: typeof payload?.description === 'string' ? payload.description : undefined,
    status: payload?.status ?? 'running',
    needSearch: payload?.needSearch,
    searchResult: payload?.searchResult,
    result,
  } as taskType;
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
      // 设计上 simpleAnalysis 同时承担两个角色：
      //   1) 写入 deep-research store，供右栏 ProcessHeader 渲染；
      //   2) 作为左侧 chat 气泡的「开场分析」append 进 assistant message——
      //      它是 plan 阶段一次性产出的结构化文本，不会通过 STREAM_CHUNK 流式吐字，
      //      所以必须在这里显式 append；否则左气泡里 plan 阶段的开场会缺失。
      //
      // 中段（emit_plan ↔ 各 task ↔ emit_report 之间）lead 的过渡语 STREAM_CHUNK
      // 在 stream-chat-handler 里被显式屏蔽（避免与右栏 ProcessHeader/任务进度重复），
      // 所以左气泡正文 = 这里的开场 + emit_report 之后 lead 收尾的 STREAM_CHUNK。
      if (data.type === 'start_analyse' && data.payload) {
        params.setSimpleAnalysis(data.payload.simpleAnalysis);
        params.setResearchTargt(data.payload.researchTarget);
        params.setStatus('processing');
        return accumulatedContent + data.payload.simpleAnalysis;
      }

      // emit_report：最终 markdown 报告
      if (data.type === 'report' && data.payload) {
        params.updateReport(data.payload);
        params.setStatus('end');
      }

      // emit_plan 第 2 帧：tasks_initial（plan 任务大纲）
      if (data.type === 'tasks_initial' && data.payload) {
        params.initialTasks(data.payload);
        params.setIsOpenProcessSider(true);
      }

      // task_progress（折叠的 task_started/running/completed/...）
      // 动态 tasks：addTask 兜底新增；存在则按 taskId 就地合并 status/result。
      if (data.type === 'task_update' && data.payload) {
        const mapped = mapTaskProgress(data.payload);
        // 显式打开抽屉（task 流先于 plan 抵达时也能看到）
        params.setIsOpenProcessSider(true);
        // 优先 addTask（去重 + upsert），保留 plan 中已有 description
        useDeepResearchProcessStore.getState().addTask(mapped);
      }

      // ask_clarification → human_interrupt
      if (data.type === 'interrupt' && data.payload) {
        params.setInterruptRequest(data.payload);
        params.setStatus('interrupt');
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
