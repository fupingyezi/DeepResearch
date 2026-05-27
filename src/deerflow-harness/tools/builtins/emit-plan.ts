/**
 * emit_plan tool —— 深度研究 plan-mode 的结构化产出工具
 *
 * 职责：
 * - 将 plan（研究目标 / 简要分析 / 任务列表）以 LangGraph custom writer 推送给前端。
 * - 推送两条 custom payload：
 *     1) { type: 'state_update', state_type: 'simple_analysis',
 *          data: { simpleAnalysis, researchTarget } }
 *     2) { type: 'state_update', state_type: 'tasks_initial', data: tasks }
 * - 返回的 ToolMessage 把 plan 文本回写到 messages，让 lead-agent 后续读到。
 *
 * 使用约束：
 * - 在 plan-mode 中**仅可调用一次**；后续任务调度通过 task("research", ...) 完成。
 */

import { tool } from 'langchain';
import z from 'zod';

const TaskSchema = z.object({
  taskId: z
    .string()
    .min(1)
    .describe('任务标识符，建议使用形如 "task-1" / "t-001" 的稳定 ID。'),
  description: z.string().min(1).describe('任务描述（一句话，前端展示用）。'),
  needSearch: z
    .boolean()
    .optional()
    .describe('是否需要联网搜索，默认 true。'),
});

export const EmitPlanInputSchema = z.object({
  research_target: z
    .string()
    .min(1)
    .describe('用户的研究目标（一句话概括）。'),
  simple_analysis: z
    .string()
    .min(1)
    .describe('对研究目标的简要分析与拆解思路（2-4 句，前端会展示给用户）。'),
  tasks: z
    .array(TaskSchema)
    .min(1)
    .max(8)
    .describe('研究任务列表，2~6 项为佳，依赖独立、粒度清晰。'),
});

type EmitPlanInput = z.infer<typeof EmitPlanInputSchema>;

/**
 * 安全地从 runtime 中拿到 LangGraph custom writer。
 * runtime 形态因 LangChain JS 版本而异，按兼容顺序探测。
 */
function pickWriter(runtime: any): ((p: any) => void) | undefined {
  const cfgObj = (runtime?.config ?? runtime ?? {}) as Record<string, any>;
  return (
    (runtime?.writer as ((p: any) => void) | undefined) ??
    (cfgObj.writer as ((p: any) => void) | undefined)
  );
}

export const emitPlanTool = tool(
  async (input: EmitPlanInput, runtime: any) => {
    const writer = pickWriter(runtime);

    const { research_target, simple_analysis, tasks } = input;

    // —— 推 1：simple_analysis（含 research_target） ——
    try {
      writer?.({
        type: 'state_update',
        state_type: 'simple_analysis',
        data: {
          simpleAnalysis: simple_analysis,
          researchTarget: research_target,
        },
      });
    } catch (err) {
      console.warn('[emit_plan] writer simple_analysis failed:', err);
    }

    // —— 推 2：tasks_initial ——
    const normalizedTasks = tasks.map((t) => ({
      // 前端 store 的 taskType.id 由 chat-with-deep-research 落库时再分配 UUID，
      // 这里只携带 AI 生成的 taskId（前端 updateTasks 按 taskId 匹配）。
      id: t.taskId,
      taskId: t.taskId,
      description: t.description,
      status: 'pending',
      needSearch: t.needSearch ?? true,
      searchResult: [],
      result: '',
    }));

    try {
      writer?.({
        type: 'state_update',
        state_type: 'tasks_initial',
        data: normalizedTasks,
      });
    } catch (err) {
      console.warn('[emit_plan] writer tasks_initial failed:', err);
    }

    console.info(
      `[deep-research:emit_plan] target="${research_target.slice(0, 40)}…" tasks=${tasks.length}`,
    );

    // 把 plan JSON 回写给 lead-agent，便于其后续 task dispatch 时引用 taskId / description
    const planSummary = {
      research_target,
      simple_analysis,
      tasks: tasks.map((t) => ({
        taskId: t.taskId,
        description: t.description,
        needSearch: t.needSearch ?? true,
      })),
    };
    return [
      'Plan emitted successfully. The user-facing drawer is now open with the task list.',
      'Next step: dispatch each research task in order via `task("research", ...)`,',
      'and finally call `emit_report` once you have collected enough evidence.',
      '',
      '```json',
      JSON.stringify(planSummary, null, 2),
      '```',
    ].join('\n');
  },
  {
    name: 'emit_plan',
    description:
      '在深度研究模式中输出结构化的研究计划：研究目标、简要分析、任务列表。' +
      '调用本工具会自动通知前端打开"研究进度"抽屉并展示任务大纲。' +
      '在一次完整研究流程中**只能调用一次**，必须在任何 task("research", ...) 之前调用。',
    schema: EmitPlanInputSchema,
  },
);
