/**
 * 最终消息标记抽取器
 *
 * 在一轮回答的「最终 parts[]」上把 lead-agent 显式标记包裹的内容解析为独立 part：
 *  - `<final_report>...</final_report>`（或 ```final_report``` 代码块）→ artifact part
 *  - `<task_summary>...</task_summary>`                            → task_summary part
 * 命中片段会从对应文本块（text 或 reasoning part）/ artifact markdown 中 strip 掉，
 * 避免与 artifact / 总结重复展示。
 *
 * 扫描范围：text part 与 reasoning part。后者必要——lead-agent 在调用并行 task 工具
 * 的 step 中，content 会被分类为 reasoning（参见 client.ts handleAiChunk 的
 * stepHasToolCalls 分支）。
 *
 * task_summary 抽取顺序（多重兜底）：
 *  1) 优先从 text/reasoning 文本中匹配 `<task_summary>...</task_summary>`
 *  2) 若未命中且 artifact 已抽出，则在 artifact markdown 内再扫一次
 *     （应对模型把 task_summary 误写在 final_report 内部的常见情形）
 *  3) 仍未命中且本轮存在 ≥1 个 subagent_task part（多 agent 工作流），
 *     从 subagent_task part 派生总结：标题「完成 N 个子任务」+ 每行
 *     `- {description}：{structured.summary | result 首句}`
 *
 * 一致性：前端 stream-chat-handler（END）与后端 _parts-collector（finalize）
 * 调用同一函数，保证实时流式与刷新重载两端结果一致。
 */

import { v4 as uuidv4 } from 'uuid';

import type { MessagePart } from '@/types';

const FINAL_REPORT_TAG = /<final_report>([\s\S]*?)<\/final_report>/;
const FINAL_REPORT_FENCE = /```final_report\s*\n([\s\S]*?)```/;
const TASK_SUMMARY_TAG = /<task_summary>([\s\S]*?)<\/task_summary>/;

type ScannablePartType = 'text' | 'reasoning';
const SCANNABLE_TYPES: readonly ScannablePartType[] = ['text', 'reasoning'];

type ArtifactPart = Extract<MessagePart, { type: 'artifact' }>;
type TaskSummaryPart = Extract<MessagePart, { type: 'task_summary' }>;
type SubagentTaskPart = Extract<MessagePart, { type: 'subagent_task' }>;

/**
 * 解析最终 parts：strip 报告/总结标记片段，并追加 artifact / task_summary part。
 *
 * @param parts        当前累积的 parts（不被原地修改）
 * @param fallbackTitle 报告无标题时的兜底标题（通常取用户输入）
 * @returns 处理后的新 parts 数组（无变更时原样返回）
 */
export function extractFinalMessageParts(
  parts: MessagePart[],
  fallbackTitle: string,
): MessagePart[] {
  const hasArtifact = parts.some((p) => p.type === 'artifact');
  const hasTaskSummary = parts.some((p) => p.type === 'task_summary');

  const scanIndices: number[] = [];
  let combined = '';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (isScannable(part)) {
      scanIndices.push(i);
      combined += (combined ? '\n' : '') + part.content.text;
    }
  }

  let working: MessagePart[] = parts;
  let artifactPart: ArtifactPart | null = null;
  let taskSummaryPart: TaskSummaryPart | null = null;

  // 1) 优先从扫描范围（text + reasoning）抽 task_summary
  if (!hasTaskSummary && combined.length > 0) {
    const summaryMatch = combined.match(TASK_SUMMARY_TAG);
    if (summaryMatch) {
      working = stripFromScannableParts(working, scanIndices, TASK_SUMMARY_TAG);
      taskSummaryPart = makeTaskSummaryPart(summaryMatch[1].trim());
    }
  }

  // 2) 抽 final_report → artifact
  if (!hasArtifact && combined.length > 0) {
    const tagMatch = combined.match(FINAL_REPORT_TAG);
    if (tagMatch) {
      working = stripFromScannableParts(working, scanIndices, FINAL_REPORT_TAG);
      artifactPart = makeArtifactPart(tagMatch[1].trim(), fallbackTitle);
    } else {
      const fenceMatch = combined.match(FINAL_REPORT_FENCE);
      if (fenceMatch) {
        working = stripFromScannableParts(working, scanIndices, FINAL_REPORT_FENCE);
        artifactPart = makeArtifactPart(fenceMatch[1].trim(), fallbackTitle);
      } else {
        const h2Matches = combined.length > 800 ? combined.match(/^##\s+/gm) : null;
        if (h2Matches && h2Matches.length >= 2) {
          artifactPart = makeArtifactPart(combined, fallbackTitle);
        }
      }
    }
  }

  // 3) 兜底 a：若 task_summary 仍未抽到，但 artifact 抽出了，尝试在 artifact 内再扫一次
  //    （应对模型把 <task_summary> 误写在 <final_report> 内部的情形）
  if (!taskSummaryPart && !hasTaskSummary && artifactPart) {
    const innerMatch = artifactPart.content.markdown.match(TASK_SUMMARY_TAG);
    if (innerMatch) {
      taskSummaryPart = makeTaskSummaryPart(innerMatch[1].trim());
      artifactPart = {
        ...artifactPart,
        content: {
          ...artifactPart.content,
          markdown: artifactPart.content.markdown.replace(TASK_SUMMARY_TAG, '').trim(),
        },
      };
    }
  }

  // 4) 兜底 b：仍未抽到 task_summary 且本轮为多 agent 工作流（≥1 个 subagent_task）
  //    → 从 subagent_task part 派生总结，确保 UI 一定能看到「本次工作流任务总结」
  if (!taskSummaryPart && !hasTaskSummary) {
    const derived = deriveTaskSummaryFromSubagents(working);
    if (derived) taskSummaryPart = derived;
  }

  if (!artifactPart && !taskSummaryPart) return working;

  const appended: MessagePart[] = [];
  if (artifactPart) appended.push(artifactPart);
  if (taskSummaryPart) appended.push(taskSummaryPart);
  return [...working, ...appended];
}

function isScannable(part: MessagePart): part is Extract<MessagePart, { type: ScannablePartType }> {
  return (SCANNABLE_TYPES as readonly string[]).includes(part.type);
}

/** 把命中的 regex 段落从首个匹配的 text/reasoning part 内容中 strip 掉（仅命中第一处） */
function stripFromScannableParts(
  parts: MessagePart[],
  scanIndices: number[],
  regex: RegExp,
): MessagePart[] {
  const next = [...parts];
  for (const i of scanIndices) {
    const part = next[i];
    if (!part || !isScannable(part)) continue;
    if (regex.test(part.content.text)) {
      next[i] = {
        ...part,
        content: { text: part.content.text.replace(regex, '').trim() },
      };
      return next;
    }
  }
  return next;
}

/** 从报告正文首个 H1/H2 标题推断 title，缺省回退到 fallbackTitle */
function makeArtifactPart(reportContent: string, fallbackTitle: string): ArtifactPart {
  let title = '';
  const headingMatch = reportContent.match(/^#{1,2}\s+(.+?)\s*$/m);
  if (headingMatch && headingMatch[1]) title = headingMatch[1].trim();
  if (!title) title = fallbackTitle || '研究报告';
  return {
    partId: uuidv4(),
    type: 'artifact',
    createdAt: Date.now(),
    content: { title, markdown: reportContent },
  };
}

function makeTaskSummaryPart(text: string): TaskSummaryPart | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return {
    partId: uuidv4(),
    type: 'task_summary',
    createdAt: Date.now(),
    content: { text: trimmed },
  };
}

/**
 * 从已存在的 subagent_task part 派生兜底任务总结。
 *
 * 取每个 subagent_task 的 `description` 与 `structured.summary`（缺失时回退到
 * `result` 首句、再缺失则用「（无产出）」），按 deer-flow 2.0 _summarize_completed_tasks
 * 风格组装：首行「完成 N 个子任务」 + 每子任务一行 `- {description}：{产出}`。
 */
function deriveTaskSummaryFromSubagents(parts: MessagePart[]): TaskSummaryPart | null {
  const tasks = parts.filter((p): p is SubagentTaskPart => p.type === 'subagent_task');
  if (tasks.length === 0) return null;

  const lines: string[] = [`完成 ${tasks.length} 个子任务：`];
  for (let i = 0; i < tasks.length; i++) {
    const c = tasks[i].content;
    const desc = (c.description ?? '').trim() || `子任务 ${i + 1}`;
    const summary = pickTaskSummaryLine(c);
    lines.push(`- ${desc}：${summary}`);
  }
  return makeTaskSummaryPart(lines.join('\n'));
}

function pickTaskSummaryLine(content: SubagentTaskPart['content']): string {
  const structuredSummary =
    typeof content.structured?.summary === 'string' ? content.structured.summary.trim() : '';
  if (structuredSummary.length > 0) return firstSentence(structuredSummary);

  if (typeof content.result === 'string' && content.result.trim().length > 0) {
    return firstSentence(content.result.trim());
  }

  if (typeof content.error === 'string' && content.error.trim().length > 0) {
    return `执行失败：${firstSentence(content.error.trim())}`;
  }

  return '（无产出）';
}

/** 取首句（中英标点都识别），并截断到 80 字以内防止单行过长 */
function firstSentence(text: string): string {
  const stripped = text.replace(/\s+/g, ' ').trim();
  const match = stripped.match(/^(.+?[。！？!?\.])/);
  const head = match ? match[1] : stripped;
  return head.length > 80 ? `${head.slice(0, 80)}…` : head;
}
