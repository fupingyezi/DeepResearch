/**
 * LongMemEval 数据集适配器
 *
 * 将 LongMemEval JSON 格式转换为项目 BenchmarkExample 格式。
 * LongMemEval 测试 5 大长期记忆能力：
 *   1. Information Extraction (信息提取)
 *   2. Multi-Session Reasoning (多会话推理)
 *   3. Knowledge Updates (知识更新)
 *   4. Temporal Reasoning (时间推理)
 *   5. Abstention (弃权/拒绝)
 *
 * 数据来源: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 * 论文: https://arxiv.org/abs/2410.10813 (ICLR 2025)
 */

import fs from 'fs';
import path from 'path';

// ── LongMemEval 原始数据结构 ──

export interface LongMemSessionMessage {
  role: 'user' | 'assistant';
  content: string;
  has_answer?: boolean; // 该 session 是否包含答案证据
}

export interface LongMemInstance {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_dates: string[];
  /** 嵌套列表：每个子元素是一个 session 的消息数组 */
  haystack_sessions: LongMemSessionMessage[][];
}

// ── 适配后的数据结构 ──

export interface LongMemExample {
  /** LongMemEval 原始 ID */
  id: string;
  /** 问题类型（对应 5 大能力） */
  questionType: string;
  /** 是否为弃权类问题（期望模型拒绝回答） */
  isAbstention: boolean;
  /** 用户问题 */
  query: string;
  /** 标准答案 */
  referenceAnswer: string;
  /** 问题日期 */
  questionDate: string;
  /** 格式化后的聊天历史（用于注入） */
  formattedHistory: string;
  /** 原始会话数量 */
  sessionCount: number;
  /** 包含答案的会话 ID 列表 */
  answerSessionIds: string[];
  /** 原始实例（保留完整数据供高级用法） */
  raw: LongMemInstance;
}

// ── 数据加载器 ─_

const DATA_DIR = path.resolve(__dirname, '../data');

/**
 * 加载 LongMemEval 数据集
 *
 * @param variant 数据集版本: 's' (标准 ~115k tokens), 'm' (高难度 ~500 sessions), 'oracle' (仅证据会话)
 * @returns 解析后的示例列表
 */
export function loadLongMemDataset(variant: 's' | 'm' | 'oracle' = 's'): LongMemExample[] {
  const filename =
    variant === 'm'
      ? 'longmemeval_m_cleaned.json'
      : variant === 'oracle'
        ? 'longmemeval_oracle.json'
        : 'longmemeval_s_cleaned.json';

  const filePath = path.join(DATA_DIR, filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `[LongMemEval] 数据集文件不存在: ${filePath}\n` +
        `请运行以下命令下载:\n` +
        `  mkdir -p benchmarks/data &&\n` +
        `  cd benchmarks/data &&\n` +
        `  curl -L -o longmemeval_s_cleaned.json "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json" &&\n` +
        `  curl -L -o longmemeval_oracle.json "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json"`,
    );
  }

  const rawContent = fs.readFileSync(filePath, 'utf-8');
  const rawData: LongMemInstance[] = JSON.parse(rawContent);

  console.log(`[LongMemEval] 已加载 ${filename}: ${rawData.length} 条问题`);

  return rawData.map((instance) => transformInstance(instance));
}

/**
 * 将单个 LongMemInstance 转换为 LongMemExample
 */
function transformInstance(instance: LongMemInstance): LongMemExample {
  const isAbstention = instance.question_id.endsWith('_abs');

  // 格式化聊天历史为可注入的文本
  const formattedHistory = formatSessions(instance.haystack_sessions);

  return {
    id: instance.question_id,
    questionType: instance.question_type,
    isAbstention,
    query: instance.question,
    referenceAnswer: instance.answer,
    questionDate: instance.question_date,
    formattedHistory,
    sessionCount: instance.haystack_sessions.length,
    answerSessionIds: instance.answer_session_ids,
    raw: instance,
  };
}

/**
 * 将 sessions 格式化为可读文本
 *
 * 输出格式:
 *   === Session 1 (2023/05/20) ===
 *   User: ...
 *   Assistant: ...
 *   === Session 2 (2023/05/21) ===
 *   ...
 */
function formatSessions(sessions: LongMemSessionMessage[][]): string {
  const parts: string[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    if (!session || session.length === 0) continue;

    const sessionMessages = session
      .map((msg) => {
        const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
        // 截断过长的消息以控制 token 消耗
        const content =
          msg.content.length > 500 ? msg.content.slice(0, 500) + '... [truncated]' : msg.content;
        return `${roleLabel}: ${content}`;
      })
      .join('\n');

    parts.push(`=== Session ${i + 1} ===\n${sessionMessages}`);
  }

  return parts.join('\n\n');
}

// ── 统计与过滤工具 ──

/** 所有支持的 question_type 列表 */
export const LONGMEM_QUESTION_TYPES = [
  'single-session-user',
  'single-session-assistant',
  'multi-session',
  'temporal-reasoning',
  'knowledge-update',
  'abstention',
] as const;

export type LongMemQuestionType = (typeof LONGMEM_QUESTION_TYPES)[number];

/**
 * 按 question_type 过滤数据集
 */
export function filterByType(
  examples: LongMemExample[],
  types: LongMemQuestionType[],
): LongMemExample[] {
  return examples.filter((ex) => types.includes(ex.questionType as LongMemQuestionType));
}

/**
 * 获取数据集统计摘要
 */
export function getDatasetStats(examples: LongMemExample[]): {
  total: number;
  abstentionCount: number;
  typeDistribution: Record<string, number>;
} {
  const typeDistribution: Record<string, number> = {};
  let abstentionCount = 0;

  for (const ex of examples) {
    typeDistribution[ex.questionType] = (typeDistribution[ex.questionType] || 0) + 1;
    if (ex.isAbstention) abstentionCount++;
  }

  return {
    total: examples.length,
    abstentionCount,
    typeDistribution,
  };
}

/**
 * 打印数据集统计信息
 */
export function printStats(examples: LongMemExample[]): void {
  const stats = getDatasetStats(examples);

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║     LongMemEval Dataset Statistics       ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Total Questions:     ${String(stats.total).padStart(18)} ║`);
  console.log(`║  Abstention (_abs):   ${String(stats.abstentionCount).padStart(18)} ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Type Distribution:                       ║');

  for (const [type, count] of Object.entries(stats.typeDistribution).sort(
    ([, a], [, b]) => b - a,
  )) {
    const bar = '█'.repeat(Math.round((count / stats.total) * 20));
    console.log(`║    ${type.padEnd(24)} ${String(count).padStart(4)}  ${bar} ║`);
  }

  console.log('╚══════════════════════════════════════════╝');
}

// ── 导出为 LongMemEval 官方评估格式 (JSONL) ──

export interface LongMemHypothesis {
  question_id: string;
  hypothesis: string;
}

/**
 * 将结果导出为 LongMemEval 官方 JSONL 格式
 * 可直接用官方 evaluate_qa.py 评估
 */
export function exportToJSONL(
  results: Array<{ exampleId: string; output: string }>,
  outputPath: string,
): void {
  const lines: LongMemHypothesis[] = results
    .filter((r) => r.output.length > 0)
    .map(({ exampleId, output }) => ({
      question_id: exampleId,
      hypothesis: output,
    }));

  const jsonl = lines.map((l) => JSON.stringify(l)).join('\n');

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(outputPath, jsonl, 'utf-8');
  console.log(`[LongMemEval] 已导出 ${lines.length} 条结果到 ${outputPath}`);
}
