/**
 * Subagent 输出 schema 范式
 *
 * 目标：把 subagent 的最终产出从"自由文本"约束为"结构化 JSON + 可读 Markdown"，
 * 使 lead-agent 在汇总阶段可以拿到稳定的字段（findings/sources/issues），
 * 不再依赖对自由文本的二次解析。
 *
 * 协议：
 *   subagent 在最终消息末尾追加一段 fenced block：
 *
 *   ```final-report
 *   { "summary": "...", "keyFindings": [...], "sources": [...], "issues": [...] }
 *   ```
 *
 *   也允许首尾包含围栏（```json final-report 等变体）。Executor 提取 JSON 块解析；
 *   解析失败时 fallback 为整段文本（保持向后兼容）。
 */

import { z } from 'zod';

/** 关键发现条目：一个原子结论 + 支撑来源（可空，意味着这是综合判断） */
const KeyFindingSchema = z.object({
  /** 一句话陈述结论，建议 ≤ 80 字 */
  point: z.string().min(1),
  /** 支撑该结论的引用索引（指向 sources 数组下标，从 0 开始） */
  sourceIndexes: z.array(z.number().int().min(0)).default([]),
});

const SourceSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
  /** 可选：1-2 句话摘要 */
  snippet: z.string().optional(),
});

export const SubagentReportSchema = z.object({
  /** 一段话总结（≤ 200 字） */
  summary: z.string().min(1),
  /** 3-8 条关键发现 */
  keyFindings: z.array(KeyFindingSchema).min(1),
  /** 引用源；若研究无外部来源，可为空数组 */
  sources: z.array(SourceSchema).default([]),
  /** 遇到的问题/限制（可选） */
  issues: z.array(z.string()).optional(),
});

export type SubagentReport = z.infer<typeof SubagentReportSchema>;

/**
 * 给 subagent system prompt 用的 schema 描述（自然语言 + 例子）。
 * 与 Zod schema 保持同步——任一处变更，另一处需同步。
 */
export const SUBAGENT_REPORT_FORMAT_INSTRUCTION = `
<output_contract>
你必须以两段式输出最终结果：

【段一：可读的 Markdown 正文】
正文用 Markdown 写，给人阅读，包含：
- 一段简短总结（≤ 200 字）
- 3~8 条要点（关键发现），每条结尾带 [n] 引用编号
- 末尾一节 \`## Sources\`，每条 \`[n] [Title](URL) - 简述\`

【段二：结构化 JSON 报告】
正文之后，**必须**追加一段 fenced code block，语言标记为 \`final-report\`，内容是严格符合下述 schema 的 JSON：

\`\`\`final-report
{
  "summary": "一段话总结（≤200字）",
  "keyFindings": [
    { "point": "结论 1", "sourceIndexes": [0, 1] },
    { "point": "结论 2", "sourceIndexes": [2] }
  ],
  "sources": [
    { "title": "标题1", "url": "https://...", "snippet": "可选摘要" },
    { "title": "标题2", "url": "https://..." }
  ],
  "issues": ["可选：遇到的问题或限制"]
}
\`\`\`

约束：
- JSON 必须可被 \`JSON.parse\` 解析，禁止注释、尾随逗号。
- \`sourceIndexes\` 中的数字必须是 \`sources\` 数组的有效下标（0-based）。
- 没有外部来源时 \`sources\` 设为 \`[]\`，并对应空 \`sourceIndexes: []\`。
- 不要在 fenced block 之外再额外输出任何解释性文字。
</output_contract>
`.trim();

/**
 * 从 subagent 最终文本中抽取 final-report JSON。
 *
 * - 支持 ```final-report 与 ```json final-report 两种围栏标记
 * - 支持没有语言标记但内容看起来像最终 JSON 的最后一个 fenced block（容错）
 *
 * @returns { json, markdown } 解析成功时返回 schema 验证后的对象 + 去掉
 *   fenced block 的纯 markdown 正文；解析失败时 json 为 null，markdown 为原文。
 */
export function extractSubagentReport(
  raw: string | null | undefined,
): { json: SubagentReport | null; markdown: string } {
  const text = raw ?? '';
  if (!text) return { json: null, markdown: '' };

  // 优先匹配带 final-report 标记的 fenced block
  const labelled = /```(?:json\s+)?final-report\s*\n([\s\S]*?)```/i.exec(text);
  if (labelled?.[1]) {
    const parsed = tryParseReport(labelled[1]);
    if (parsed) {
      const markdown = text.replace(labelled[0], '').trim();
      return { json: parsed, markdown };
    }
  }

  // 其次：尝试整篇最后一个 fenced JSON block
  const allFences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
  for (let i = allFences.length - 1; i >= 0; i--) {
    const m = allFences[i];
    const parsed = tryParseReport(m[1]);
    if (parsed) {
      const markdown = text.replace(m[0], '').trim();
      return { json: parsed, markdown };
    }
  }

  return { json: null, markdown: text };
}

function tryParseReport(jsonText: string): SubagentReport | null {
  try {
    const obj = JSON.parse(jsonText);
    const result = SubagentReportSchema.safeParse(obj);
    if (result.success) return result.data;
  } catch {
    /* ignore */
  }
  return null;
}
