#!/usr/bin/env tsx
/**
 * LongMemEval 专用运行脚本
 *
 * 用于测试 mini-DeepResearch 的长期记忆系统在 LongMemEval 基准上的表现。
 * LongMemEval (ICLR 2025) 测试 5 大核心能力：
 *   - Information Extraction    (信息提取)
 *   - Multi-Session Reasoning   (多会话推理)
 *   - Knowledge Updates         (知识更新)
 *   - Temporal Reasoning        (时间推理)
 *   - Abstention                (弃权识别)
 *
 * 用法（从项目根目录执行）：
 *   npx tsx benchmarks/longmem/run.ts
 *   npx tsx benchmarks/longmem/run.ts --type multi-session
 *   npx tsx benchmarks/longmem/run.ts --id e47becba
 *   npx tsx benchmarks/longmem/run.ts --variant oracle
 *   npx tsx benchmarks/longmem/run.ts --no-memory          # 关闭记忆系统（对照实验）
 *   npx tsx benchmarks/longmem/run.ts --history-mode system # 使用 system prompt 注入历史
 *   npx tsx benchmarks/longmem/run.ts --no-websearch        # 关闭 Web Search（默认已关闭，省 API 额度）
 *   npx tsx benchmarks/longmem/run.ts --websearch           # 显式开启 Web Search
 *   npx tsx benchmarks/longmem/run.ts --no-judge            # 跳过自动准确率评估（默认开启）
 *   npx tsx benchmarks/longmem/run.ts --ingest              # 两阶段：先把 sessions 写入记忆系统，再靠记忆检索作答（真正测长期记忆）
 *
 * 环境变量：见 benchmarks/.env.example
 */

import '../load-env';

import fs from 'fs';
import path from 'path';

import { ChatOpenAI } from '@langchain/openai';

import defaultConfig, { validateEnv } from '../config';
import {
  loadLongMemDataset,
  printStats,
  filterByType,
  exportToJSONL,
  type LongMemExample,
  type LongMemQuestionType,
} from './dataset';
import { createLongMemAgent, type LongMemAgentResult } from './agent';
import {
  installMemoryModelFactory,
  ingestExample,
  exampleUserId,
  type IngestStats,
} from './ingest';

// ── CLI 参数解析 ──

interface LongMemArgs {
  /** 按 question_type 过滤 */
  type?: string;
  /** 按具体 question_id 运行 */
  id?: string;
  /** 数据集版本: 's' | 'm' | 'oracle' */
  variant: 's' | 'm' | 'oracle';
  /** 是否关闭 memory（用于对照实验） */
  noMemory: boolean;
  /** 历史注入模式 */
  historyMode: 'prefix' | 'system' | 'none';
  /** 是否启用 web search（默认 false） */
  webSearchEnabled: boolean;
  /** 是否用 LLM judge 自动评估准确率（默认 true） */
  judge: boolean;
  /**
   * 两阶段记忆评测开关（默认 false）。
   * - false：prefix 模式，把全部历史拼进 prompt（测「长 prompt 阅读理解」）。
   * - true ：先逐 session 写入长期记忆系统，提问时不注入历史、靠记忆检索作答
   *          （测「记忆写入→存储→跨 session 检索」的端到端能力）。
   */
  ingest: boolean;
  /** 输出路径 */
  output: string;
  /** 最大执行数量（调试用） */
  limit?: number;
  /** 并发数 */
  concurrency: number;
}

function parseArgs(): LongMemArgs {
  const args = process.argv.slice(2);
  return {
    type: args.find((a, i) => a === '--type')
      ? args[args.indexOf('--type') + 1]
      : undefined,
    id: args.find((a, i) => a === '--id') ? args[args.indexOf('--id') + 1] : undefined,
    variant: (args.includes('--variant')
      ? (args[args.indexOf('--variant') + 1] as 's' | 'm' | 'oracle')
      : 's'),
    noMemory: args.includes('--no-memory') || args.includes('--noMemory'),
    historyMode: (args.includes('--history-mode')
      ? (args[args.indexOf('--history-mode') + 1] as 'prefix' | 'system' | 'none')
      : 'prefix'
    ) as 'prefix' | 'system' | 'none',
    // 默认关闭 websearch：测试纯记忆能力，避免消耗 Tavily API 额度
    webSearchEnabled: args.includes('--websearch'),
    // 默认开启 LLM judge 自动评估准确率，--no-judge 可跳过
    judge: !args.includes('--no-judge'),
    // 两阶段记忆评测（默认关闭，开启会显著增加 LLM 调用：每个 session 抽取一次）
    ingest: args.includes('--ingest'),
    output: args.find((a, i) => a === '--output')
      ? args[args.indexOf('--output') + 1]
      : 'benchmarks/results/longmem/latest.json',
    limit: args.find((a, i) => a === '--limit')
      ? parseInt(args[args.indexOf('--limit') + 1], 10)
      : undefined,
    concurrency: args.find((a, i) => a === '--concurrency')
      ? parseInt(args[args.indexOf('--concurrency') + 1], 10)
      : defaultConfig.run.concurrency,
  };
}

// ── 过滤数据集 ──

function filterDataset(dataset: LongMemExample[], args: LongMemArgs): LongMemExample[] {
  let filtered = [...dataset];

  if (args.type) {
    filtered = filtered.filter((ex) => ex.questionType === args.type);
    console.log(`[LongMem] 按类型过滤: ${args.type} (${filtered.length} 条)`);
  }

  if (args.id) {
    filtered = filtered.filter((ex) => ex.id === args.id);
    console.log(`[LongMem] 按 ID 过滤: ${args.id} (${filtered.length} 条)`);
  }

  if (args.limit && args.limit > 0) {
    filtered = filtered.slice(0, args.limit);
    console.log(`[LongMem] 限制数量: ${args.limit} 条`);
  }

  return filtered;
}

// ── 执行单条测试 ──

/** 单条测试结果（judgment 在评估阶段填充） */
interface LongMemResultItem {
  exampleId: string;
  questionType: string;
  isAbstention: boolean;
  query: string;
  referenceAnswer: string;
  result: LongMemAgentResult;
  /** 记忆写入阶段统计（仅 --ingest 模式填充） */
  ingest?: IngestStats;
  /** LLM judge 评估结果（开启 --judge 时填充） */
  judgment?: {
    correct: boolean;
    reasoning: string;
  };
}

async function runSingle(
  agent: ReturnType<typeof createLongMemAgent>,
  example: LongMemExample,
  opts: { ingest: boolean },
): Promise<LongMemResultItem> {
  console.log(`\n  [Running] ${example.questionType}: "${example.query.slice(0, 80)}..."`);

  let ingestStats: IngestStats | undefined;
  let userId: string | undefined;

  if (opts.ingest) {
    // ── 阶段 1：把全部 haystack sessions 写入长期记忆系统 ──
    userId = exampleUserId(example);
    const total = example.raw.haystack_sessions?.length ?? 0;
    process.stdout.write(`    [Ingest] 写入记忆: 0/${total} sessions`);
    ingestStats = await ingestExample(example, userId, (done, t) => {
      // 原地刷新进度
      process.stdout.write(`\r    [Ingest] 写入记忆: ${done}/${t} sessions   `);
    });
    process.stdout.write(
      `\r    [Ingest] 写入完成: ${ingestStats.sessionsWritten}/${ingestStats.sessionsProcessed} sessions, ` +
        `${ingestStats.factCount} facts, ${(ingestStats.ingestMs / 1000).toFixed(1)}s\n`,
    );
  }

  // ── 阶段 2：提问 ──
  // ingest 模式：不注入历史，靠 lead-agent 从记忆里检索作答；
  // prefix 模式：把全部历史拼进 prompt（原行为）。
  const result = await agent({
    query: example.query,
    formattedHistory: opts.ingest ? undefined : example.formattedHistory,
    userId,
  });

  // 打印简要结果
  const status = result.metrics.error ? 'ERROR' : 'OK';
  const textPreview = result.output.slice(0, 150) + (result.output.length > 150 ? '...' : '');
  console.log(
    `    [${status}] ${result.metrics.totalLatencyMs}ms | ` +
    `${result.output.length} chars | tools=${result.metrics.toolCallCount}`,
  );
  console.log(`    [Output] ${textPreview}`);
  console.log(`    [Answer ] ${example.referenceAnswer}`);

  return {
    exampleId: example.id,
    questionType: example.questionType,
    isAbstention: example.isAbstention,
    query: example.query,
    referenceAnswer: example.referenceAnswer,
    result,
    ingest: ingestStats,
  };
}

// ── LLM Judge：二元正确性判定（对齐 LongMemEval 官方评估口径）──

/**
 * LongMemEval 的评估是二元的：judge 判断 Agent 回答是否「正确」。
 * - 普通题：回答是否包含参考答案的关键信息（语义等价即可，不要求字面一致）
 * - 弃权题(_abs)：正确答案是 Agent 应当表示「信息不足/无法回答」，
 *   而不是编造一个具体答案。
 */
const JUDGE_SYSTEM_PROMPT = `You are a strict evaluator for a long-term memory QA benchmark.
Given a question, the reference (gold) answer, and a model's response, decide whether the model's response is CORRECT.

Rules:
- Judge by semantic equivalence, not exact wording. Different phrasing, language (中文/English), or extra explanation is fine as long as the core fact matches the reference answer.
- The response is CORRECT only if it clearly states the fact in the reference answer. A hesitant guess that ultimately gives the right fact still counts as correct; refusing or saying "I don't know" when an answer exists is INCORRECT.
- Output STRICT JSON only, no markdown:
{"correct": true|false, "reasoning": "one short sentence"}`;

const JUDGE_ABSTENTION_PROMPT = `You are a strict evaluator for a long-term memory QA benchmark.
This is an ABSTENTION question: the correct behavior is for the model to recognize that the information was NEVER provided and to refrain from answering (e.g. say it doesn't know / no such record exists).

Rules:
- CORRECT if the model declines to answer, says the info is missing/unknown, or asks for clarification instead of fabricating a concrete answer.
- INCORRECT if the model confidently makes up a specific answer.
- Output STRICT JSON only, no markdown:
{"correct": true|false, "reasoning": "one short sentence"}`;

function createJudgeModel(): ChatOpenAI {
  const j = defaultConfig.judge;
  // 优先用专门的 judge 配置；未配置 judge apiKey 时回退到 agent 模型（复用已有 key）
  const hasJudgeKey = Boolean(j.apiKey);
  const modelName = hasJudgeKey ? j.modelName : defaultConfig.agent.modelName;
  const apiKey = hasJudgeKey ? j.apiKey : defaultConfig.agent.apiKey;
  const baseUrl = hasJudgeKey ? j.baseUrl : defaultConfig.agent.baseUrl;

  console.log(
    `[Judge] 使用评估模型: ${modelName}${hasJudgeKey ? '' : ' (回退到 agent 模型，未配置 BENCHMARK_JUDGE_API_KEY)'}`,
  );

  return new ChatOpenAI({
    model: modelName,
    apiKey,
    configuration: baseUrl ? { baseURL: baseUrl } : undefined,
    temperature: 0,
  });
}

async function judgeOne(
  model: ChatOpenAI,
  item: LongMemResultItem,
): Promise<{ correct: boolean; reasoning: string }> {
  // Agent 报错的条目直接判错
  if (item.result.metrics.error) {
    return { correct: false, reasoning: 'Agent 执行出错' };
  }

  const systemPrompt = item.isAbstention ? JUDGE_ABSTENTION_PROMPT : JUDGE_SYSTEM_PROMPT;
  const userPrompt = item.isAbstention
    ? `Question: ${item.query}\n\nModel Response: ${item.result.output || '(empty)'}`
    : `Question: ${item.query}\n\nReference Answer: ${item.referenceAnswer}\n\nModel Response: ${
        item.result.output || '(empty)'
      }`;

  try {
    const resp = await model.invoke([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);
    const raw = resp.content as string;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('judge 输出无法解析 JSON');
    const parsed = JSON.parse(match[0]);
    return {
      correct: Boolean(parsed.correct),
      reasoning: String(parsed.reasoning ?? ''),
    };
  } catch (e: any) {
    return { correct: false, reasoning: `judge 失败: ${e.message}` };
  }
}

/** 批量评估所有结果（带并发控制），就地写入 judgment 字段 */
async function judgeAll(
  results: LongMemResultItem[],
  concurrency: number,
): Promise<void> {
  const model = createJudgeModel();
  console.log(`\n[Judge] 开始评估 ${results.length} 条结果...`);

  for (let i = 0; i < results.length; i += concurrency) {
    const batch = results.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (item) => {
        item.judgment = await judgeOne(model, item);
        const mark = item.judgment.correct ? '✓' : '✗';
        console.log(`  [Judge ${mark}] ${item.exampleId} (${item.questionType})`);
      }),
    );
  }
}

// ── 报告生成 ──

interface LongMemReport {
  runAt: string;
  config: {
    agentModel: string;
    variant: string;
    memoryEnabled: boolean;
    historyMode: string;
    webSearchEnabled: boolean;
    /** 是否为两阶段记忆评测（--ingest） */
    ingest: boolean;
    datasetSize: number;
  };
  summary: {
    totalExamples: number;
    successCount: number;
    errorCount: number;
    avgLatencyMs: number;
    avgTtftMs: number;
    avgOutputLength: number;
    /** 是否执行了 judge 评估 */
    judged: boolean;
    /** 已评估条数 */
    judgedCount: number;
    /** 判定正确条数 */
    correctCount: number;
    /** 整体准确率 0-1（judgedCount>0 时有效） */
    accuracy: number;
    /** 按 question_type 分组的统计 */
    byType: Record<
      string,
      { total: number; success: number; correct: number; avgLatency: number }
    >;
  };
  results: LongMemResultItem[];
}

function generateReport(
  results: LongMemReport['results'],
  config: LongMemReport['config'],
): LongMemReport {
  const successResults = results.filter((r) => !r.result.metrics.error);

  // 按 type 分组统计
  const byType: Record<
    string,
    { total: number; success: number; correct: number; avgLatency: number }
  > = {};
  for (const r of results) {
    if (!byType[r.questionType]) {
      byType[r.questionType] = { total: 0, success: 0, correct: 0, avgLatency: 0 };
    }
    const stat = byType[r.questionType];
    stat.total++;
    if (!r.result.metrics.error) {
      stat.success++;
      stat.avgLatency += r.result.metrics.totalLatencyMs;
    }
    if (r.judgment?.correct) {
      stat.correct++;
    }
  }

  // 计算平均延迟
  for (const key of Object.keys(byType)) {
    const stat = byType[key];
    if (stat.success > 0) {
      stat.avgLatency = Math.round(stat.avgLatency / stat.success);
    }
  }

  // 准确率统计
  const judgedResults = results.filter((r) => r.judgment !== undefined);
  const correctCount = judgedResults.filter((r) => r.judgment?.correct).length;
  const judgedCount = judgedResults.length;

  return {
    runAt: new Date().toISOString(),
    config,
    summary: {
      totalExamples: results.length,
      successCount: successResults.length,
      errorCount: results.filter((r) => r.result.metrics.error).length,
      judged: judgedCount > 0,
      judgedCount,
      correctCount,
      accuracy: judgedCount > 0 ? Math.round((correctCount / judgedCount) * 10000) / 10000 : 0,
      avgLatencyMs:
        successResults.length > 0
          ? Math.round(
              successResults.reduce((s, r) => s + r.result.metrics.totalLatencyMs, 0) /
                successResults.length,
            )
          : 0,
      avgTtftMs:
        successResults.length > 0
          ? Math.round(
              successResults.reduce((s, r) => s + r.result.metrics.ttftMs, 0) /
                successResults.length,
            )
          : 0,
      avgOutputLength:
        successResults.length > 0
          ? Math.round(
              successResults.reduce((s, r) => s + r.result.output.length, 0) /
                successResults.length,
            )
          : 0,
      byType,
    },
    results,
  };
}

function printReport(report: LongMemReport): void {
  console.log('\n' + '='.repeat(70));
  console.log('  LONGMEMEVAL BENCHMARK REPORT');
  console.log('='.repeat(70));
  console.log(`  Time:         ${report.runAt}`);
  console.log(`  Model:        ${report.config.agentModel}`);
  console.log(`  Variant:      ${report.config.variant} (${report.config.datasetSize} questions)`);
  console.log(`  Memory:       ${report.config.memoryEnabled ? 'ENABLED ✓' : 'DISABLED ✗'}`);
  console.log(
    `  Eval Mode:    ${
      report.config.ingest
        ? 'INGEST (两阶段：写入记忆→检索作答)'
        : `PREFIX (历史直接进 prompt, history-mode=${report.config.historyMode})`
    }`,
  );
  console.log(`  Web Search:   ${report.config.webSearchEnabled ? 'ON' : 'OFF'}\n`);

  const { summary } = report;

  // ── 记忆写入阶段汇总（仅 ingest 模式）──
  if (report.config.ingest) {
    const ing = report.results.map((r) => r.ingest).filter((x): x is IngestStats => !!x);
    if (ing.length > 0) {
      const avgSessions = ing.reduce((s, x) => s + x.sessionsProcessed, 0) / ing.length;
      const avgFacts = ing.reduce((s, x) => s + x.factCount, 0) / ing.length;
      const avgIngestMs = ing.reduce((s, x) => s + x.ingestMs, 0) / ing.length;
      console.log('  ┌──────────────────────────────────────────────┐');
      console.log('  │ Memory Ingestion (Phase 1)                  │');
      console.log('  ├────────────────┬─────────────────────────────┤');
      console.log(`  │ Avg Sessions   │ ${avgSessions.toFixed(1).padStart(25)} │`);
      console.log(`  │ Avg Facts      │ ${avgFacts.toFixed(1).padStart(25)} │`);
      console.log(`  │ Avg Ingest     │ ${(avgIngestMs / 1000).toFixed(1).padStart(25)}s │`);
      console.log('  └────────────────┴─────────────────────────────┘\n');
    }
  }

  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │ Summary                                     │');
  console.log('  ├────────────────┬─────────────────────────────┤');
  console.log(`  │ Total          │ ${String(summary.totalExamples).padStart(25)} │`);
  console.log(`  │ Success        │ ${String(summary.successCount).padStart(25)} │`);
  console.log(`  │ Errors         │ ${String(summary.errorCount).padStart(25)} │`);
  console.log(`  │ Avg Latency    │ ${(summary.avgLatencyMs / 1000).toFixed(1).padStart(25)}s │`);
  console.log(`  │ Avg TTFT       │ ${(summary.avgTtftMs / 1000).toFixed(1).padStart(25)}s │`);
  console.log(`  │ Avg Output     │ ${String(Math.round(summary.avgOutputLength)).padStart(25)} chars │`);
  console.log('  └────────────────┴─────────────────────────────┘');

  // ── 准确率（核心指标）──
  if (summary.judged) {
    const accPct = (summary.accuracy * 100).toFixed(1);
    console.log('\n  ┌──────────────────────────────────────────────┐');
    console.log('  │ Accuracy (LLM Judge)                        │');
    console.log('  ├────────────────┬─────────────────────────────┤');
    console.log(`  │ Correct        │ ${`${summary.correctCount} / ${summary.judgedCount}`.padStart(25)} │`);
    console.log(`  │ Accuracy       │ ${`${accPct}%`.padStart(25)} │`);
    console.log('  └────────────────┴─────────────────────────────┘');
  } else {
    console.log('\n  [提示] 未执行 LLM judge 评估（使用了 --no-judge）。准确率不可用。');
  }

  console.log('\n  Results by Question Type:');
  console.log('  ┌────────────────────────┬──────┬───────┬──────────┬──────────┐');
  console.log('  │ Type                   │ Total│Correct│ Accuracy │Avg Latency');
  console.log('  ├────────────────────────┼──────┼───────┼──────────┼──────────┤');

  const sortedTypes = Object.entries(summary.byType).sort(([, a], [, b]) => b.total - a.total);
  for (const [type, stat] of sortedTypes) {
    const acc = stat.total > 0 ? ((stat.correct / stat.total) * 100).toFixed(1) + '%' : '-';
    console.log(
      `  │ ${type.padEnd(24)} │ ${String(stat.total).padStart(4)} │ ${String(stat.correct).padStart(5)} │ ${(summary.judged ? acc : '-').padStart(8)} │ ${(stat.avgLatency / 1000).toFixed(1).padStart(8)}s │`,
    );
  }

  console.log('  └────────────────────────┴──────┴───────┴──────────┴──────────┘');

  console.log('\n' + '='.repeat(70));
  if (!summary.judged) {
    console.log('\n  可选：也可用官方脚本进行 GPT-4o Judge 评估');
    console.log('  1. 结果已导出为 JSONL 格式');
    console.log('  2. 用官方 evaluate_qa.py 进行精确评估');
  }
}

// ── 主入口（导出让 research-qa/run.ts 可以路由调用）──

export async function main(): Promise<void> {
  validateEnv();

  const config = defaultConfig;
  const args = parseArgs();

  // 加载数据集
  const fullDataset = loadLongMemDataset(args.variant);
  printStats(fullDataset);

  // 过滤
  const dataset = filterDataset(fullDataset, args);

  if (dataset.length === 0) {
    console.error('[LongMem] 过滤后数据集为空，请检查过滤条件');
    process.exit(1);
  }

  // ── 记忆系统准备 ──
  // 只要开启了记忆（默认开启，除非 --no-memory），就必须注入 memory model factory，
  // 否则 memoryMiddleware.afterAgent 入队的更新会在队列里因「无 model factory」被全部
  // 跳过（日志刷屏 "No model factory configured; skip LLM update."）。
  // 注意：ingest 模式与 prefix 模式都开记忆，因此这里不能只在 ingest 分支里装 factory。
  const memoryActive = !args.noMemory;
  if (memoryActive) {
    // 注入 memory model factory（否则 MemoryUpdater 是空操作）
    installMemoryModelFactory({
      modelName: config.agent.modelName,
      baseUrl: config.agent.baseUrl,
      apiKey: config.agent.apiKey,
    });
  }

  // ── 两阶段记忆评测准备 ──
  if (args.ingest) {
    if (args.noMemory) {
      console.error('[LongMem] --ingest 与 --no-memory 互斥：两阶段评测必须开启记忆系统');
      process.exit(1);
    }
    // 把记忆落盘隔离到 benchmark 本地目录，避免污染 ~/.deer-flow，且便于清理
    if (!process.env.DEERFLOW_DATA_DIR) {
      process.env.DEERFLOW_DATA_DIR = path.resolve('benchmarks/.memory-store');
    }
    console.log(`[LongMem] 记忆存储目录: ${process.env.DEERFLOW_DATA_DIR}`);
  }

  // 打印运行配置
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║     LongMemEval Benchmark Runner             ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Agent Model:   ${config.agent.modelName.padStart(30)}║`);
  console.log(`║  Memory System: ${(args.noMemory ? 'DISABLED' : 'ENABLED').padStart(30)}║`);
  console.log(
    `║  Eval Mode:     ${(args.ingest ? 'INGEST (两阶段)' : `PREFIX (${args.historyMode})`).padStart(30)}║`,
  );
  console.log(`║  Web Search:    ${(args.webSearchEnabled ? 'ON' : 'OFF (默认)').padStart(30)}║`);
  console.log(`║  LLM Judge:     ${(args.judge ? 'ON (自动评准确率)' : 'OFF').padStart(30)}║`);
  console.log(`║  Dataset Var:    ${args.variant.padStart(29)}║`);
  console.log(
    `║  Questions:     ${String(fullDataset.length).padStart(6)} → ${String(dataset.length).padStart(3)} 待执行║`,
  );
  console.log(`║  Concurrency:    ${String(args.ingest ? 1 : args.concurrency).padStart(30)}║`);
  console.log('╚══════════════════════════════════════════════╝');

  // 创建 Agent（开启 memory 测试长期记忆）
  const agent = createLongMemAgent({
    modelName: config.agent.modelName,
    baseUrl: config.agent.baseUrl,
    apiKey: config.agent.apiKey,
    memoryEnabled: !args.noMemory,
    historyMode: args.historyMode,
    webSearchEnabled: args.webSearchEnabled,
  });

  // 执行 Benchmark
  const startTime = Date.now();
  const results: LongMemReport['results'] = [];

  // ingest 模式强制串行：每个 example 写同一记忆文件、且抽取调用密集，
  // 串行可保证进度日志清晰并避免 LLM 限流。
  const batchSize = args.ingest ? 1 : args.concurrency;
  const runOpts = { ingest: args.ingest };
  for (let i = 0; i < dataset.length; i += batchSize) {
    const batch = dataset.slice(i, i + batchSize);

    if (batch.length === 1) {
      // 单条直接执行
      const result = await runSingle(agent, batch[0], runOpts);
      results.push(result);
    } else {
      // 多条并发
      const batchResults = await Promise.all(
        batch.map((example) => runSingle(agent, example, runOpts)),
      );
      results.push(...batchResults);
    }

    // 进度显示
    const done = Math.min(i + batchSize, dataset.length);
    console.log(`\n  [Progress] ${done}/${dataset.length} completed`);
  }

  // LLM Judge 自动评估准确率（默认开启，--no-judge 跳过）
  if (args.judge) {
    await judgeAll(results, args.concurrency);
  }

  // 生成报告
  const reportConfig = {
    agentModel: config.agent.modelName,
    variant: args.variant,
    memoryEnabled: !args.noMemory,
    historyMode: args.historyMode,
    webSearchEnabled: args.webSearchEnabled,
    ingest: args.ingest,
    datasetSize: dataset.length,
  };

  const report = generateReport(results, reportConfig);
  printReport(report);

  // 保存结果 JSON
  const dir = path.dirname(args.output);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(args.output, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\n[Report] 结果已保存到 ${args.output}`);

  // 导出为 LongMemEval 官方 JSONL 格式（可用于官方评估脚本）
  const jsonlPath = args.output.replace('.json', '.jsonl');
  exportToJSONL(
    results.map((r) => ({ exampleId: r.exampleId, output: r.result.output })),
    jsonlPath,
  );

  console.log(`\n[LongMem] 总耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log('\n提示: 如需使用 GPT-4o 进行精确评估，请安装 LongMemEval 官方工具:');
  console.log('  git clone https://github.com/xiaowu0162/LongMemEval.git');
  console.log('  cd LongMemEval/src/evaluation');
  console.log('  python3 evaluate_qa.py gpt-4o <jsonl_path> ../../data/longmemeval_oracle.json');
}

main().catch((e) => {
  console.error('[LongMem] Fatal error:', e);
  process.exit(1);
});
