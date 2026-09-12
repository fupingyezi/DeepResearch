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
 *   pnpm bench:longmem
 *   pnpm bench:longmem -- --type multi-session
 *   pnpm bench:longmem -- --id e47becba
 *   pnpm bench:longmem -- --variant oracle
 *   pnpm bench:longmem -- --no-memory           # 关闭记忆系统（对照实验）
 *   pnpm bench:longmem -- --history-mode system # 用 system prompt 注入历史
 *   pnpm bench:longmem -- --websearch           # 显式开启 Web Search（默认关闭）
 *   pnpm bench:longmem -- --no-judge            # 跳过自动准确率评估（默认开启）
 *   pnpm bench:longmem:ingest                   # 两阶段：先写记忆，再靠检索作答
 *
 * 环境变量：见 benchmarks/.env.example
 */

import '../load-env';

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';

import { ChatOpenAI } from '@langchain/openai';

import defaultConfig, { BenchmarkConfigError, validateEnv } from '../config';
import { computeRunCost, type UsageCost } from '../../src/deerflow-harness/runtime/pricing';
import {
  UsageAccumulator,
  mergeRunUsage,
  tokenUsageFromUsageMetadata,
  withUsageAccounting,
  type RunUsage,
  type TokenUsage,
} from '../../src/deerflow-harness/runtime/usage-accounting';
import {
  loadLongMemDataset,
  printStats,
  filterByType,
  exportToJSONL,
  type LongMemExample,
  type LongMemQuestionType,
} from './dataset';
import { createLongMemAgent, type LongMemAgentResult, type PerformanceMetrics } from './agent';
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
    type: args.find((a, i) => a === '--type') ? args[args.indexOf('--type') + 1] : undefined,
    id: args.find((a, i) => a === '--id') ? args[args.indexOf('--id') + 1] : undefined,
    variant: args.includes('--variant')
      ? (args[args.indexOf('--variant') + 1] as 's' | 'm' | 'oracle')
      : 's',
    noMemory: args.includes('--no-memory') || args.includes('--noMemory'),
    historyMode: (args.includes('--history-mode')
      ? (args[args.indexOf('--history-mode') + 1] as 'prefix' | 'system' | 'none')
      : 'prefix') as 'prefix' | 'system' | 'none',
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

/**
 * 落盘用的 agent 结果 —— **不含原始事件流**（单条就有上千条逐 token 事件，
 * 实测占报告体积 97%）。只留按类型计数；细排请看 LangSmith trace。
 */
interface ReportedAgentResult {
  output: string;
  metrics: PerformanceMetrics;
  eventTypes: Record<string, number>;
  /**
   * 该条目的完整用量（含**逐次调用记录**）—— 计价依赖每次调用自己的时间戳
   * （高峰/空闲差一倍），只存总数会让从报告重算费用变得不可能。
   */
  usage?: RunUsage;
}

function toReportedResult(result: LongMemAgentResult): ReportedAgentResult {
  const eventTypes: Record<string, number> = {};
  for (const event of result.events) {
    eventTypes[event.eventType] = (eventTypes[event.eventType] ?? 0) + 1;
  }
  return {
    output: result.output,
    metrics: result.metrics,
    eventTypes,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

/** 单条测试结果（judgment 在评估阶段填充） */
interface LongMemResultItem {
  exampleId: string;
  questionType: string;
  isAbstention: boolean;
  query: string;
  referenceAnswer: string;
  result: ReportedAgentResult;
  /** 记忆写入阶段统计（仅 --ingest 模式填充） */
  ingest?: IngestStats;
  /** 记忆写入阶段的 LLM 用量（仅 --ingest 模式填充） */
  ingestUsage?: RunUsage;
  /** LLM judge 评估结果（开启 --judge 时填充） */
  judgment?: {
    correct: boolean;
    reasoning: string;
    /** 该次 judge 调用的用量（judge 不经模型工厂，就地读取响应） */
    usage?: TokenUsage;
    /**
     * 判定来源。只有 `'valid'` 才是「模型答对/答错」；
     * `'agent_error'` / `'judge_error'` / `'timeout'` 都是**基础设施故障**，
     * 不计入 accuracy 分母（见 generateReport 的 infraFailureCount）。
     */
    kind?: 'valid' | 'agent_error' | 'judge_error' | 'timeout';
  };
}

async function runSingle(
  agent: ReturnType<typeof createLongMemAgent>,
  example: LongMemExample,
  opts: { ingest: boolean },
): Promise<LongMemResultItem> {
  console.log(`\n  [Running] ${example.questionType}: "${example.query.slice(0, 80)}..."`);

  let ingestStats: IngestStats | undefined;
  let ingestUsage: RunUsage | undefined;
  let userId: string | undefined;

  if (opts.ingest) {
    // ── 阶段 1：把全部 haystack sessions 写入长期记忆系统 ──
    userId = exampleUserId(example);
    const total = example.raw.haystack_sessions?.length ?? 0;
    process.stdout.write(`    [Ingest] 写入记忆: 0/${total} sessions`);
    // 记忆抽取走 createChatModel（见 ingest.ts 的 installMemoryModelFactory），
    // 因此包一层记账即可捕获 ingest 阶段的用量 —— 这是 LongMemEval 的成本大头。
    const accounted = await withUsageAccounting(() =>
      ingestExample(example, userId!, (done, t) => {
        // 原地刷新进度
        process.stdout.write(`\r    [Ingest] 写入记忆: ${done}/${t} sessions   `);
      }),
    );
    ingestStats = accounted.result;
    ingestUsage = accounted.usage;
    process.stdout.write(
      `\r    [Ingest] 写入完成: ${ingestStats.sessionsWritten}/${ingestStats.sessionsProcessed} sessions, ` +
        `${ingestStats.factCount} facts, ${(ingestStats.ingestMs / 1000).toFixed(1)}s\n`,
    );
    process.stdout.write(`    [Ingest] 用量: ${ingestUsage.total.llmCalls} 次调用\n`);
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
    result: toReportedResult(result),
    ingest: ingestStats,
    ingestUsage,
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

/**
 * 构建 judge 模型。
 *
 * **不再回退到 agent 模型**：此前未配 `BENCHMARK_JUDGE_API_KEY` 时会静默改用 agent
 * 模型自评（只在 console 打一行），报告里看不出任何差别。现在缺配置由 `validateEnv()`
 * 直接报错退出；想显式不评分请用 `--no-judge`。
 */
function createJudgeModel(): { model: ChatOpenAI; modelName: string } {
  const j = defaultConfig.judge;

  if (!j.apiKey) {
    throw new Error(
      '[Judge] 缺少 BENCHMARK_JUDGE_API_KEY。judge 侧没有 DEEPSEEK_* 回落，' +
        '请显式配置（可与 agent 共用同一把 key），或用 --no-judge 显式跳过评分。',
    );
  }
  if (!j.baseUrl) {
    throw new Error(
      '[Judge] 缺少 BENCHMARK_JUDGE_BASE_URL。judge 侧不会回落到 DEEPSEEK_BASE_URL，' +
        '漏配会让请求带着 key 打到 api.openai.com。DeepSeek 填 https://api.deepseek.com/v1。',
    );
  }

  console.log(`[Judge] 使用评估模型: ${j.modelName}（baseUrl=${j.baseUrl}）`);
  return {
    model: new ChatOpenAI({
      model: j.modelName,
      apiKey: j.apiKey,
      configuration: { baseURL: j.baseUrl },
      temperature: 0,
    }),
    modelName: j.modelName,
  };
}

async function judgeOne(
  model: ChatOpenAI,
  item: LongMemResultItem,
  timeoutMs: number,
): Promise<{
  correct: boolean;
  reasoning: string;
  kind: NonNullable<LongMemResultItem['judgment']>['kind'];
  usage?: TokenUsage;
}> {
  // Agent 报错/超时的条目判错，但标记为基础设施故障 —— 不计入 accuracy 分母，
  // 否则「评测环境抖动」会伪装成「模型答错」。
  if (item.result.metrics.error) {
    const kind = item.result.metrics.errorKind === 'timeout' ? 'timeout' : 'agent_error';
    return { correct: false, reasoning: `Agent 执行出错（${kind}）`, kind };
  }

  const systemPrompt = item.isAbstention ? JUDGE_ABSTENTION_PROMPT : JUDGE_SYSTEM_PROMPT;
  const userPrompt = item.isAbstention
    ? `Question: ${item.query}\n\nModel Response: ${item.result.output || '(empty)'}`
    : `Question: ${item.query}\n\nReference Answer: ${item.referenceAnswer}\n\nModel Response: ${
        item.result.output || '(empty)'
      }`;

  // judge 调用超时（signal 会让底层请求真正中止）
  const controller = new AbortController();
  let timedOut = false;
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : undefined;

  try {
    const resp = await model.invoke(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { signal: controller.signal },
    );
    const raw = resp.content as string;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('judge 输出无法解析 JSON');
    const parsed = JSON.parse(match[0]);
    return {
      correct: Boolean(parsed.correct),
      reasoning: String(parsed.reasoning ?? ''),
      kind: 'valid',
      // judge 模型不经模型工厂，没有 callback 记账，就地读取响应上的 usage
      usage: tokenUsageFromUsageMetadata(resp.usage_metadata),
    };
  } catch (e: any) {
    return {
      correct: false,
      reasoning: timedOut ? `judge 超时（${timeoutMs}ms）` : `judge 失败: ${e.message}`,
      kind: 'judge_error',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 批量评估所有结果（带并发控制），就地写入 judgment 字段 */
async function judgeAll(
  results: LongMemResultItem[],
  concurrency: number,
  timeoutMs: number,
): Promise<{ modelName: string; usage: RunUsage }> {
  const { model, modelName } = createJudgeModel();
  const usage = new UsageAccumulator();
  console.log(`\n[Judge] 开始评估 ${results.length} 条结果...`);

  for (let i = 0; i < results.length; i += concurrency) {
    const batch = results.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (item) => {
        item.judgment = await judgeOne(model, item, timeoutMs);
        if (item.judgment.usage) {
          // synthetic runId：judge 模型不经模型工厂、没有 callback 的 runId 可用，
          // 每次调用给一个唯一值即可（累加器用它去重）。
          usage.record(randomUUID(), {
            modelName,
            usage: item.judgment.usage,
            at: Date.now(),
          });
        }
        const mark = item.judgment.correct ? '✓' : '✗';
        const flag = item.judgment.kind === 'valid' ? '' : ` [${item.judgment.kind}]`;
        console.log(`  [Judge ${mark}${flag}] ${item.exampleId} (${item.questionType})`);
      }),
    );
  }

  return { modelName, usage: usage.snapshot() };
}

// ── 报告生成 ──

/**
 * 报告里的 token 与费用。
 *
 * token 数是**实测**（来自 API 的 usage），费用是按 `pricing.json` 估算 —— 两者分开列，
 * 价格表过期时 token 依然可信。
 */
interface AccountingBlock {
  usage: {
    agent: TokenUsage;
    ingest: TokenUsage;
    judge: TokenUsage;
    total: TokenUsage;
  };
  cost: {
    currency: string;
    priceAsOf: string;
    priceSource: string;
    agent: number;
    ingest: number;
    judge: number;
    total: number;
    /** 全部调用若都落在高峰时段的总价（现实上界；空闲价恰为高峰半价） */
    ifAllPeakTotal: number;
    /** 出现在用量里但价格表没有的模型 —— 它们的费用**未**计入上面的数字 */
    unknownModels: string[];
    /** 拿不到用量的调用数（费用被低估）/ 只有粗粒度用量的调用数（被高估） */
    callsMissingUsage: number;
    callsCoarseUsage: number;
  };
}

interface LongMemReport {
  runAt: string;
  config: {
    agentModel: string;
    /** judge **实际**使用的模型；未评分时为 null（记录实际生效值，而非配置意图） */
    judgeModel: string | null;
    variant: string;
    memoryEnabled: boolean;
    historyMode: string;
    webSearchEnabled: boolean;
    /** 是否为两阶段记忆评测（--ingest） */
    ingest: boolean;
    datasetSize: number;
    /** 单次 agent run / judge 调用的超时（ms） */
    timeoutMs: number;
  };
  summary: {
    totalExamples: number;
    successCount: number;
    errorCount: number;
    /** 其中因超时中止的条数 */
    timeoutCount: number;
    avgLatencyMs: number;
    avgTtftMs: number;
    avgOutputLength: number;
    /** 是否执行了 judge 评估 */
    judged: boolean;
    /**
     * 有效判定条数 —— accuracy 的分母。**不含**基础设施故障
     * （agent 报错/超时、judge 失败），那些单独记在 infraFailureCount。
     */
    judgedCount: number;
    /** 判定正确条数 */
    correctCount: number;
    /** 整体准确率 0-1（judgedCount>0 时有效） */
    accuracy: number;
    /**
     * 被剔除出 accuracy 分母的条数（agent 报错/超时、judge 失败）。
     * 单独暴露的原因：这些是**评测环境故障**，混进分母会伪装成「模型答错」。
     */
    infraFailureCount: number;
    /** 按 question_type 分组的统计（correct/judged 只含有效判定，与整体口径一致） */
    byType: Record<
      string,
      { total: number; success: number; correct: number; judged: number; avgLatency: number }
    >;
    /** token 用量与费用（按角色拆分） */
    accounting: AccountingBlock;
  };
  results: LongMemResultItem[];
}

function generateReport(
  results: LongMemReport['results'],
  config: LongMemReport['config'],
  judgeUsage: RunUsage,
): LongMemReport {
  const successResults = results.filter((r) => !r.result.metrics.error);

  /** 有效判定：真的判了「对/错」，而不是「跑挂了」。 */
  const isValidJudgment = (r: LongMemResultItem): boolean =>
    r.judgment !== undefined && (r.judgment.kind ?? 'valid') === 'valid';

  // 按 type 分组统计（correct 只计有效判定，与整体 accuracy 口径一致）
  const byType: LongMemReport['summary']['byType'] = {};
  for (const r of results) {
    if (!byType[r.questionType]) {
      byType[r.questionType] = { total: 0, success: 0, correct: 0, judged: 0, avgLatency: 0 };
    }
    const stat = byType[r.questionType];
    stat.total++;
    if (!r.result.metrics.error) {
      stat.success++;
      stat.avgLatency += r.result.metrics.totalLatencyMs;
    }
    if (isValidJudgment(r)) {
      stat.judged++;
      if (r.judgment!.correct) stat.correct++;
    }
  }

  // 计算平均延迟
  for (const key of Object.keys(byType)) {
    const stat = byType[key];
    if (stat.success > 0) {
      stat.avgLatency = Math.round(stat.avgLatency / stat.success);
    }
  }

  // 准确率统计：分母只含有效判定，基础设施故障单独计数。
  // 此前 agent 报错与 judge 失败都被折成 correct:false 混进分母 —— 评测环境抖动
  // 会看起来像「模型答错」，且报告里无从分辨。
  const validJudgments = results.filter(isValidJudgment);
  const correctCount = validJudgments.filter((r) => r.judgment?.correct).length;
  const judgedCount = validJudgments.length;
  const infraFailureCount = results.length - judgedCount;

  // 记账：按角色分别汇总（agent 提问 / ingest 记忆写入 / judge 评分）。
  // 必须保留逐次调用记录 —— 计价依赖每次调用自己的时间戳（高峰/空闲差一倍）。
  const agentUsage = mergeRunUsage(results.map((r) => r.result.usage));
  const ingestUsage = mergeRunUsage(results.map((r) => r.ingestUsage));
  const totalUsage = mergeRunUsage([agentUsage, ingestUsage, judgeUsage]);
  const agentCost = computeRunCost(agentUsage);
  const ingestCost = computeRunCost(ingestUsage);
  const judgeCost = computeRunCost(judgeUsage);

  return {
    runAt: new Date().toISOString(),
    config,
    summary: {
      totalExamples: results.length,
      successCount: successResults.length,
      errorCount: results.filter((r) => r.result.metrics.error).length,
      timeoutCount: results.filter((r) => r.result.metrics.errorKind === 'timeout').length,
      judged: judgedCount > 0,
      judgedCount,
      correctCount,
      accuracy: judgedCount > 0 ? Math.round((correctCount / judgedCount) * 10000) / 10000 : 0,
      infraFailureCount,
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
      accounting: {
        usage: {
          agent: agentUsage.total,
          ingest: ingestUsage.total,
          judge: judgeUsage.total,
          total: totalUsage.total,
        },
        cost: {
          currency: agentCost.currency,
          priceAsOf: agentCost.priceAsOf,
          priceSource: agentCost.priceSource,
          agent: agentCost.total,
          ingest: ingestCost.total,
          judge: judgeCost.total,
          total: agentCost.total + ingestCost.total + judgeCost.total,
          ifAllPeakTotal: agentCost.ifAllPeak + ingestCost.ifAllPeak + judgeCost.ifAllPeak,
          unknownModels: [
            ...new Set([
              ...agentCost.unknownModels,
              ...ingestCost.unknownModels,
              ...judgeCost.unknownModels,
            ]),
          ],
          // totalUsage 已含 agent/ingest/judge 三者，直接取它的缺口计数即可（别再相加）
          callsMissingUsage: totalUsage.callsMissingUsage,
          callsCoarseUsage: totalUsage.callsCoarseUsage,
        },
      },
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
  console.log(`  Judge Model:  ${report.config.judgeModel ?? '(未评分 —— --no-judge)'}`);
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
  console.log(
    `  │ Avg Output     │ ${String(Math.round(summary.avgOutputLength)).padStart(25)} chars │`,
  );
  console.log('  └────────────────┴─────────────────────────────┘');

  // ── 准确率（核心指标）──
  if (summary.judged) {
    const accPct = (summary.accuracy * 100).toFixed(1);
    console.log('\n  ┌──────────────────────────────────────────────┐');
    console.log('  │ Accuracy (LLM Judge)                        │');
    console.log('  ├────────────────┬─────────────────────────────┤');
    console.log(
      `  │ Correct        │ ${`${summary.correctCount} / ${summary.judgedCount}`.padStart(25)} │`,
    );
    console.log(`  │ Accuracy       │ ${`${accPct}%`.padStart(25)} │`);
    console.log('  └────────────────┴─────────────────────────────┘');
    console.log('    ↑ 分母只含有效判定；基础设施故障已剔除（见下方 Infra Failures）');

    if (summary.infraFailureCount > 0 || summary.timeoutCount > 0) {
      console.log('\n  ┌──────────────────────────────────────────────┐');
      console.log('  │ Infra Failures（不计入 accuracy 分母）        │');
      console.log('  ├────────────────┬─────────────────────────────┤');
      console.log(`  │ Agent 报错/超时 │ ${String(summary.errorCount).padStart(25)} │`);
      console.log(`  │ 其中超时       │ ${String(summary.timeoutCount).padStart(25)} │`);
      console.log(
        `  │ Judge 失败     │ ${String(summary.infraFailureCount - summary.errorCount).padStart(
          25,
        )} │`,
      );
      console.log('  └────────────────┴─────────────────────────────┘');
    }
  } else {
    console.log('\n  [提示] 未执行 LLM judge 评估（使用了 --no-judge）。准确率不可用。');
  }

  // ── 成本（token 是实测，金额按 pricing.json 估算）──
  const { accounting } = summary;
  const yuan = (n: number) => `¥${n.toFixed(4)}`;
  console.log('\n  ┌──────────────────────────────────────────────┐');
  console.log('  │ Token & Cost                                │');
  console.log('  ├────────────────┬─────────────────────────────┤');
  for (const role of ['agent', 'ingest', 'judge'] as const) {
    const u = accounting.usage[role];
    console.log(
      `  │ ${role.padEnd(14)} │ ${`${u.llmCalls} calls, in ${u.inputTokens}（命中 ${u.cacheReadTokens}）/ out ${u.outputTokens}`.padStart(25)} │`,
    );
  }
  console.log(
    `  │ ${'合计 token'.padEnd(14)} │ ${String(accounting.usage.total.inputTokens + accounting.usage.total.outputTokens).padStart(25)} │`,
  );
  console.log(`  │ ${'成本 agent'.padEnd(14)} │ ${yuan(accounting.cost.agent).padStart(25)} │`);
  if (accounting.cost.ingest > 0) {
    console.log(`  │ ${'成本 ingest'.padEnd(14)} │ ${yuan(accounting.cost.ingest).padStart(25)} │`);
  }
  console.log(`  │ ${'成本 judge'.padEnd(14)} │ ${yuan(accounting.cost.judge).padStart(25)} │`);
  console.log(`  │ ${'成本 合计'.padEnd(14)} │ ${yuan(accounting.cost.total).padStart(25)} │`);
  console.log('  └────────────────┴─────────────────────────────┘');
  console.log(
    `    价格表 ${accounting.cost.priceAsOf}（${accounting.cost.currency}）；全部落在高峰时段则约 ${yuan(
      accounting.cost.ifAllPeakTotal,
    )}`,
  );

  // 记账缺口：数字不可信时必须说出来，而不是让读者以为成本已经算全了
  const gaps: string[] = [];
  if (accounting.cost.callsMissingUsage > 0) {
    gaps.push(`${accounting.cost.callsMissingUsage} 次调用没拿到 usage（成本被低估）`);
  }
  if (accounting.cost.callsCoarseUsage > 0) {
    gaps.push(
      `${accounting.cost.callsCoarseUsage} 次只有粗粒度 usage（缓存命中体现不出，成本被高估）`,
    );
  }
  if (accounting.cost.unknownModels.length > 0) {
    gaps.push(`价格表缺少模型 ${accounting.cost.unknownModels.join(', ')}（其费用未计入）`);
  }
  if (gaps.length > 0) {
    console.log(`  ⚠️  记账缺口：${gaps.join('；')}`);
  }

  console.log('\n  Results by Question Type:');
  console.log('  ┌────────────────────────┬──────┬───────┬──────────┬──────────┐');
  console.log('  │ Type                   │ Total│Correct│ Accuracy │Avg Latency');
  console.log('  ├────────────────────────┼──────┼───────┼──────────┼──────────┤');

  const sortedTypes = Object.entries(summary.byType).sort(([, a], [, b]) => b.total - a.total);
  for (const [type, stat] of sortedTypes) {
    // 分母用有效判定数（stat.judged），与整体 accuracy 同口径
    const acc = stat.judged > 0 ? ((stat.correct / stat.judged) * 100).toFixed(1) + '%' : '-';
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
  const config = defaultConfig;
  const args = parseArgs();

  // 先解析参数再校验：--no-judge 是「显式不评分」的逃生口，校验必须知道它。
  validateEnv({ skipJudge: !args.judge });

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
    // 此前 BENCHMARK_TIMEOUT_MS 是死配置：挂住的 run 会永远挂着
    timeoutMs: config.run.timeoutMs,
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
  let judgeModel: string | null = null;
  let judgeUsage: RunUsage = mergeRunUsage([]);
  if (args.judge) {
    const judged = await judgeAll(results, args.concurrency, config.run.timeoutMs);
    judgeModel = judged.modelName;
    judgeUsage = judged.usage;
  } else {
    console.log('\n[Judge] 已用 --no-judge 显式跳过评分：本次不产出 accuracy。');
  }

  // 生成报告（记录**实际生效**的 judge 模型，而不是配置里写的那个）
  const reportConfig = {
    agentModel: config.agent.modelName,
    judgeModel,
    variant: args.variant,
    memoryEnabled: !args.noMemory,
    historyMode: args.historyMode,
    webSearchEnabled: args.webSearchEnabled,
    ingest: args.ingest,
    datasetSize: dataset.length,
    timeoutMs: config.run.timeoutMs,
  };

  const report = generateReport(results, reportConfig, judgeUsage);
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

// 入口守卫：只在**直接执行**本文件时跑 main()。
//
// 此前是裸的 `main().catch(...)`，而本模块同时被 research-qa/run.ts 以
// `await import('../longmem/run')` 的方式路由调用 —— 于是 import 会触发一次
// main()、紧接着 `await longMemMain()` 又跑第二次，**两个 run 并发抢同一个输出
// 文件与同一个 benchmarks/.memory-store**。
const isDirectRun =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((e) => {
    if (e instanceof BenchmarkConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    console.error('[LongMem] Fatal error:', e);
    process.exit(1);
  });
}
