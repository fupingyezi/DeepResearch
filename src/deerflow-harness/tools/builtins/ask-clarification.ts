/**
 * ask_clarification tool —— 深度研究 plan-mode 的人工澄清入口
 *
 * 职责：
 * - 当模型在 plan / 执行过程中遇到不确定的关键决策（研究范围、敏感前提、
 *   多义任务）时，调用本工具向用户发起澄清。
 * - 工具自身负责通过 LangGraph custom writer 推送 `human_interrupt` 业务事件，
 *   让前端弹出 HumanDecision 决策面板。
 * - 真正的"图收尾"由 ClarificationMiddleware 在 afterModel 钩子里实现：
 *   一旦 lead-agent 在某轮 AIMessage 中调用了 ask_clarification，
 *   后续 tool 节点产生 ToolMessage 后，下一轮 model 调用前会被 middleware
 *   改写消息历史以阻止继续工具调用，使图收敛到 END。
 *
 * 使用约束：
 * - 一次研究流程中尽量只调用 0~1 次。频繁澄清会拖慢用户体验。
 * - 调用本工具的同一轮**不要并发其它工具调用**。
 */

import { tool } from 'langchain';
import z from 'zod';

export const AskClarificationInputSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe('要向用户询问的问题，单句、可直接展示给用户。'),
  details: z
    .unknown()
    .optional()
    .describe(
      '可选的上下文，便于前端在决策面板中给出更多说明（自由结构）。',
    ),
});

type AskClarificationInput = z.infer<typeof AskClarificationInputSchema>;

function pickWriter(runtime: any): ((p: unknown) => void) | undefined {
  const cfgObj = (runtime?.config ?? runtime ?? {}) as Record<string, unknown>;
  return (
    (runtime?.writer as ((p: unknown) => void) | undefined) ??
    (cfgObj.writer as ((p: unknown) => void) | undefined)
  );
}

export const askClarificationTool = tool(
  async (input: AskClarificationInput, runtime: any) => {
    const { question, details } = input;
    const writer = pickWriter(runtime);

    try {
      writer?.({
        type: 'human_interrupt',
        payload: {
          question,
          details: details ?? null,
        },
      });
    } catch (err) {
      console.warn('[ask_clarification] writer failed:', err);
    }

    console.info(
      `[deep-research:ask_clarification] question="${question.slice(0, 60)}…"`,
    );
    return `Clarification requested: ${question}`;
  },
  {
    name: 'ask_clarification',
    description:
      '当研究范围 / 关键决策存在重大歧义时，向用户发起一次澄清询问。' +
      '调用之后流程会暂停等待用户回复；用户的下一条消息会自动作为澄清答复继续推进。',
    schema: AskClarificationInputSchema,
  },
);
