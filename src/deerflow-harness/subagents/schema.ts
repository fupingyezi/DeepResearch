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
 *   解析失败时退化为整段文本，但围栏始终会被剥掉，避免前端把 final-report
 *   原样当代码块渲染。
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
 * 容忍变体的 final-report 围栏正则：
 * - 围栏：``` 或 ~~~（3 个或更多）
 * - 标签：final-report / final_report / finalreport / final report，前后可有 json 修饰
 * - 标签前后空白、首行换行可缺
 * - 收尾围栏可缺（被截断时贪婪到末尾）
 *
 * 捕获组：
 *   1: 开围栏字符（用于回引匹配收尾）
 *   2: JSON body
 */
const LABELLED_FENCE_RE =
  /(`{3,}|~{3,})[ \t]*(?:json[ \t-]*)?final[-_ ]?report[ \t]*(?:json)?[ \t]*\n?([\s\S]*?)(?:\1|$)/i;

/**
 * 兜底清洗：把任何"看起来是 final-report 围栏块"的片段从 markdown 中剥掉。
 * 即使 JSON 报废、提取失败，也保证前端不会显示难看的代码块。
 */
const STRIP_LABELLED_FENCE_RE =
  /(`{3,}|~{3,})[ \t]*(?:json[ \t-]*)?final[-_ ]?report[ \t]*(?:json)?[\s\S]*?(?:\1|$)/gi;

/**
 * 普通 fenced JSON 块（无 final-report 标签时的二次尝试）。
 */
const ANY_JSON_FENCE_RE = /(`{3,}|~{3,})[ \t]*(?:json|jsonc)?[ \t]*\n([\s\S]*?)\1/gi;

/**
 * 从 subagent 最终文本中抽取 final-report JSON。
 *
 * 提取顺序：
 *   1) 容忍变体的 ```final-report``` 围栏 → 严格 schema → 宽松 schema
 *   2) 末尾 ```json``` 围栏 → 严格 schema → 宽松 schema
 *   3) 文末"裸"JSON 对象（容错最后一次）
 *   4) markdown 兜底解析（## Sources / ### / 列表项 / 首段）
 *
 * @returns { json, markdown }
 *   - json:     解析（严格、宽松、或 markdown 兜底）成功的报告对象；都失败时为 null
 *   - markdown: 已剥掉所有 final-report 围栏 + 已采用 JSON 块的纯 markdown 正文
 */
export function extractSubagentReport(raw: string | null | undefined): {
  json: SubagentReport | null;
  markdown: string;
} {
  const text = raw ?? '';
  if (!text) return { json: null, markdown: '' };

  let workingText = text;
  let parsed: SubagentReport | null = null;

  // 1) 优先：带 final-report 标签的围栏
  const labelled = LABELLED_FENCE_RE.exec(workingText);
  if (labelled) {
    parsed = parseReportFlexible(labelled[2] ?? '');
    workingText = workingText.replace(labelled[0], '');
  }

  // 2) 次选：找最后一个普通 ```json``` 块尝试解析（仅在 1 失败时）
  if (!parsed) {
    const fences = [...workingText.matchAll(ANY_JSON_FENCE_RE)];
    for (let i = fences.length - 1; i >= 0; i--) {
      const m = fences[i];
      const candidate = parseReportFlexible(m[2] ?? '');
      if (candidate) {
        parsed = candidate;
        workingText = workingText.replace(m[0], '');
        break;
      }
    }
  }

  // 3) 末选：文末裸 JSON 对象（{ ... }）
  if (!parsed) {
    const trailing = /\{[\s\S]*\}\s*$/.exec(workingText.trim());
    if (trailing) {
      const candidate = parseReportFlexible(trailing[0]);
      if (candidate) {
        parsed = candidate;
        workingText = workingText.replace(trailing[0], '');
      }
    }
  }

  // 兜底清洗：任何残留的 final-report 围栏（含未闭合、变体）一律剥掉
  const markdown = workingText.replace(STRIP_LABELLED_FENCE_RE, '').trim();

  // 4) markdown 兜底：JSON 提取全部失败 / 提取到的报告 sources 为空时，
  //    从 markdown 正文回填 summary / sources / keyFindings。
  if (!parsed) {
    parsed = parseReportFromMarkdown(markdown);
  } else if ((parsed.sources ?? []).length === 0) {
    const fromMd = parseReportFromMarkdown(markdown);
    if (fromMd && fromMd.sources.length > 0) {
      parsed = { ...parsed, sources: fromMd.sources };
    }
  }

  return { json: parsed, markdown };
}

/**
 * 从 markdown 正文兜底解析 SubagentReport。
 *
 * 解析口径：
 * - summary：取首个非 heading 段落，截断到 200 字。
 * - sources：从 `## Sources` / `## 参考资料` 章节解析所有 markdown 链接 `[Title](URL)`，
 *   并在段尾抓取 `- 描述` 部分作为 snippet；按 url 去重。
 * - keyFindings：取 `### {子标题}` 与正文 `- ` 列表项前 8 条作为 point。
 *
 * 返回 null 表示 markdown 信息量不足以构成报告。
 */
export function parseReportFromMarkdown(markdown: string): SubagentReport | null {
  const text = (markdown ?? '').trim();
  if (text.length === 0) return null;

  const summary = extractFirstParagraph(text);
  const sources = extractSourcesFromMarkdown(text);
  const keyFindings = extractKeyFindingsFromMarkdown(text);

  if (!summary && sources.length === 0 && keyFindings.length === 0) return null;

  const finalSummary = summary || keyFindings[0]?.point || '(no summary)';
  const finalKeyFindings =
    keyFindings.length > 0
      ? keyFindings
      : [{ point: finalSummary.slice(0, 80) || '(no findings)', sourceIndexes: [] }];

  return {
    summary: finalSummary,
    keyFindings: finalKeyFindings,
    sources,
  };
}

/** 取首个非 heading、非空白段落，截断到 200 字。 */
function extractFirstParagraph(text: string): string {
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    if (/^#{1,6}\s+/.test(trimmed)) continue;
    if (/^>\s*/.test(trimmed)) continue; // 跳过 TL;DR 引用块
    const oneLine = trimmed.replace(/\s+/g, ' ').trim();
    return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
  }
  return '';
}

/**
 * 从 ## Sources / ## 参考资料 章节中解析 [Title](URL) 链接 + 可选 snippet。
 * 章节边界：从 H2 到下一个 H2 / EOF。
 *
 * JS 正则没有 \Z (EOF anchor)，使用 lookahead `(?=^##\s+|$(?![\s\S]))` 表示
 * 「下一个 H2 或文末」。
 */
function extractSourcesFromMarkdown(
  text: string,
): Array<{ title: string; url: string; snippet?: string }> {
  const sectionPattern =
    /^##\s+(?:sources|参考资料|references|引用)\b[\s\S]*?(?=^##\s+|$(?![\s\S]))/gim;
  const sections = text.match(sectionPattern) ?? [];
  const out: Array<{ title: string; url: string; snippet?: string }> = [];
  const seenUrls = new Set<string>();

  // 章节内整行匹配： `- [Title](URL) - 描述` 或 `[Title](URL)`
  const linkLineRe = /^[\s>*\-+]*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\s*(?:[-—–:]\s*(.+))?$/gm;

  for (const section of sections) {
    let match: RegExpExecArray | null;
    linkLineRe.lastIndex = 0;
    while ((match = linkLineRe.exec(section)) !== null) {
      const title = match[1].trim();
      const url = match[2].trim();
      const snippet = match[3]?.trim();
      if (!title || !url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      out.push(snippet ? { title, url, snippet } : { title, url });
    }
  }
  return out;
}

/**
 * 提取关键发现：优先取 `### {子标题}` 后的首句；否则取顶层 `- ` 列表项。
 * 上限 8 条，去除引用编号 `[n]`，截断到 80 字。
 */
function extractKeyFindingsFromMarkdown(
  text: string,
): Array<{ point: string; sourceIndexes: number[] }> {
  const out: Array<{ point: string; sourceIndexes: number[] }> = [];

  const h3Re = /^###\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = h3Re.exec(text)) !== null) {
    if (out.length >= 8) break;
    const point = sanitizeFindingText(m[1]);
    if (point) out.push({ point, sourceIndexes: [] });
  }

  if (out.length < 8) {
    const bulletRe = /^[\s]*[-*+]\s+(.+?)\s*$/gm;
    while ((m = bulletRe.exec(text)) !== null) {
      if (out.length >= 8) break;
      // 跳过链接行（已在 sources 中处理）
      if (/^\s*\[[^\]]+\]\(https?:/.test(m[1])) continue;
      const point = sanitizeFindingText(m[1]);
      if (point) out.push({ point, sourceIndexes: [] });
    }
  }

  return out;
}

function sanitizeFindingText(raw: string): string {
  const stripped = raw
    .replace(/\[citation:[^\]]+\]\([^)]+\)/g, '')
    .replace(/\[(\d+)\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length === 0) return '';
  return stripped.length > 80 ? `${stripped.slice(0, 80)}…` : stripped;
}

// 解析辅助

/**
 * 双层尝试：严格 schema 失败时回落到宽松 schema，再失败才返回 null。
 */
function parseReportFlexible(jsonText: string): SubagentReport | null {
  const cleaned = sanitizeJsonText(jsonText);
  if (!cleaned) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  // 严格 schema
  const strict = SubagentReportSchema.safeParse(obj);
  if (strict.success) return strict.data;

  // 宽松 schema：允许字段缺失 / 空数组 / url 为空
  const loose = LooseReportSchema.safeParse(obj);
  if (loose.success) return normalizeLooseReport(loose.data);

  return null;
}

/**
 * 容错预处理：
 * - 去 BOM、首尾空白
 * - 去掉单行 // 注释、块 /* ... *\/ 注释
 * - 去掉对象/数组的尾随逗号
 *
 * 不做"单引号→双引号"等激进改写，避免误伤 JSON 字符串内的合法引号。
 */
function sanitizeJsonText(s: string): string {
  if (!s) return '';
  let t = s.replace(/^\uFEFF/, '').trim();
  // 去掉 // 行注释（粗略：忽略字符串内的可能性，作为容错足够）
  t = t.replace(/(^|[^:"\\])\/\/[^\n]*/g, '$1');
  // 去掉 /* ... */ 块注释
  t = t.replace(/\/\*[\s\S]*?\*\//g, '');
  // 去掉对象/数组前的尾随逗号 ,]  ,}
  t = t.replace(/,(\s*[}\]])/g, '$1');
  return t.trim();
}

/**
 * 宽松 schema：兼容模型偶尔少字段、url 为空、字段名变体。
 * 解析后由 normalizeLooseReport 统一规整成 SubagentReport。
 */
const LooseKeyFindingSchema = z.looseObject({
  point: z.string().min(1).optional(),
  text: z.string().min(1).optional(), // 模型有时写成 text
  finding: z.string().min(1).optional(), // 或 finding
  sourceIndexes: z.array(z.number().int().min(0)).optional(),
  source_indexes: z.array(z.number().int().min(0)).optional(), // 蛇形兜底
});

const LooseSourceSchema = z.looseObject({
  title: z.string().optional(),
  url: z.string().optional(),
  link: z.string().optional(), // url 别名兜底
  snippet: z.string().optional(),
  summary: z.string().optional(),
});

const LooseReportSchema = z.looseObject({
  summary: z.string().optional(),
  overview: z.string().optional(),
  keyFindings: z.array(LooseKeyFindingSchema).optional(),
  key_findings: z.array(LooseKeyFindingSchema).optional(),
  findings: z.array(LooseKeyFindingSchema).optional(),
  sources: z.array(LooseSourceSchema).optional(),
  references: z.array(LooseSourceSchema).optional(),
  issues: z.array(z.string()).optional(),
});

type LooseReport = z.infer<typeof LooseReportSchema>;

function normalizeLooseReport(loose: LooseReport): SubagentReport | null {
  const summary =
    (typeof loose.summary === 'string' && loose.summary.trim()) ||
    (typeof loose.overview === 'string' && loose.overview.trim()) ||
    '';

  const rawFindings = loose.keyFindings ?? loose.key_findings ?? loose.findings ?? [];
  const keyFindings = rawFindings
    .map((kf) => {
      const point =
        (typeof kf.point === 'string' && kf.point.trim()) ||
        (typeof kf.text === 'string' && kf.text.trim()) ||
        (typeof kf.finding === 'string' && kf.finding.trim()) ||
        '';
      const sourceIndexes = kf.sourceIndexes ?? kf.source_indexes ?? [];
      return point ? { point, sourceIndexes } : null;
    })
    .filter((v): v is { point: string; sourceIndexes: number[] } => v !== null);

  const rawSources = loose.sources ?? loose.references ?? [];
  type NormalizedSource = SubagentReport['sources'][number];
  const sources: NormalizedSource[] = rawSources
    .map((s): NormalizedSource | null => {
      const title = (typeof s.title === 'string' && s.title.trim()) || '';
      const url =
        (typeof s.url === 'string' && s.url.trim()) ||
        (typeof s.link === 'string' && s.link.trim()) ||
        '';
      // url 必须非空才算合法源；否则跳过此条
      if (!title || !url) return null;
      const snippet =
        (typeof s.snippet === 'string' && s.snippet.trim()) ||
        (typeof s.summary === 'string' && s.summary.trim()) ||
        undefined;
      return snippet ? { title, url, snippet } : { title, url };
    })
    .filter((v): v is NormalizedSource => v !== null);

  // 至少要有 summary 或一条 keyFinding 才认为是有效报告
  if (!summary && keyFindings.length === 0) return null;

  // 补默认 summary，避免下游 SubagentReport 类型断言出错
  const finalSummary = summary || keyFindings[0]?.point || '(no summary)';
  const finalKeyFindings =
    keyFindings.length > 0
      ? keyFindings
      : [{ point: finalSummary.slice(0, 80) || '(no findings)', sourceIndexes: [] }];

  return {
    summary: finalSummary,
    keyFindings: finalKeyFindings,
    sources,
    issues: loose.issues,
  };
}
