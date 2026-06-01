import { tool } from 'langchain';
import { interrupt } from '@langchain/langgraph';
import z from 'zod';

/**
 * ask_clarification tool —— 基于 LangGraph 原生 interrupt 的按需澄清
 *
 * 复用 LangGraph 现成的 HITL 能力（`interrupt()` + `Command({ resume })`），
 * 不自造事件协议：
 * 1) Lead agent 在需求歧义/信息缺失/多方案/危险操作时调用本工具。
 * 2) interrupt({ question, details }) 暂停图执行并把问题抛给上游；
 *    DeerFlowClient.stream 侦测到 __interrupt__ 后转成 HUMAN_INTERRUPT 客户端事件。
 * 3) 用户作答后，ThreadService.resume 以 Command({ resume: decision }) 续跑，
 *    interrupt 返回该 decision，工具据此把澄清结果写回给 LLM 继续推进。
 *
 * 关键不变量：lead agent 必须挂载 checkpointer（interrupt 依赖 checkpoint 暂存）；
 * subagent 不应装载本工具（无用户交互上下文）。
 */
const ClarificationInputSchema = z.object({
  question: z.string().min(1).describe('要向用户澄清的问题，简洁明确，一次只问关键点。'),
  details: z.string().optional().describe('可选：补充说明、可选项或背景，帮助用户快速作答。'),
});

export const askClarificationTool = tool(
  (input) => {
    const { question, details } = input;
    const decision = interrupt({ question, details: details ?? null });
    const answer = typeof decision === 'string' ? decision : JSON.stringify(decision ?? '');
    return `User clarification: ${answer}`;
  },
  {
    name: 'ask_clarification',
    description:
      'Ask the user a clarifying question when the request is ambiguous, missing key ' +
      'information, has multiple viable approaches, or involves risky/irreversible actions. ' +
      'Call this BEFORE planning or acting. Execution pauses until the user replies.',
    schema: ClarificationInputSchema,
  },
);
