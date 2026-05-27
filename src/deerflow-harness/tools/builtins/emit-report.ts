/**
 * emit_report tool —— 深度研究 plan-mode 的最终报告产出工具
 *
 * 职责：
 * - 把模型生成的最终 markdown 报告以 LangGraph custom writer 推送给前端。
 *   payload: { type:'state_update', state_type:'report', data: markdown }
 * - 触发后前端 deep-research store 会切换到 'end' 状态、并把 tab 切到 "report"。
 *
 * 使用约束：
 * - 在 plan-mode 中**仅可调用一次**，必须在所有 task("research", ...) 完成后调用。
 * - 调用 emit_report 之后**不得再调任何工具**，下一步只能用普通 AI 文本结束本轮。
 */

import { tool } from 'langchain';
import z from 'zod';

export const EmitReportInputSchema = z.object({
  markdown: z
    .string()
    .min(1)
    .describe(
      '最终研究报告，使用 markdown 格式。要求：包含标题层级、要点列表、必要的引用链接；' +
        '不要再嵌入 JSON / 工具调用。',
    ),
});

type EmitReportInput = z.infer<typeof EmitReportInputSchema>;

function pickWriter(runtime: any): ((p: any) => void) | undefined {
  const cfgObj = (runtime?.config ?? runtime ?? {}) as Record<string, any>;
  return (
    (runtime?.writer as ((p: any) => void) | undefined) ??
    (cfgObj.writer as ((p: any) => void) | undefined)
  );
}

export const emitReportTool = tool(
  async (input: EmitReportInput, runtime: any) => {
    const writer = pickWriter(runtime);
    const { markdown } = input;

    try {
      writer?.({
        type: 'state_update',
        state_type: 'report',
        data: markdown,
      });
    } catch (err) {
      console.warn('[emit_report] writer failed:', err);
    }

    console.info(`[deep-research:emit_report] size=${markdown.length} chars`);

    return 'Report emitted successfully. Do NOT call any more tools; respond with a brief closing message.';
  },
  {
    name: 'emit_report',
    description:
      '在深度研究模式中输出最终的 markdown 研究报告。调用后前端会切换到"报告"标签页。' +
      '本工具**只能在所有 task 完成后调用一次**；调用之后不得再发起任何工具调用。',
    schema: EmitReportInputSchema,
  },
);
