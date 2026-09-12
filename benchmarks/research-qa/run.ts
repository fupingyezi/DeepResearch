#!/usr/bin/env tsx
/**
 * Benchmark 主执行脚本
 *
 * 用法（从项目根目录执行）：
 *   pnpm bench:qa
 *   pnpm bench:qa -- --category multi-hop
 *   pnpm bench:qa -- --id fact-001
 *   pnpm bench:qa -- --no-judge          # 显式跳过 LLM 评分（不要求 judge 配置）
 *   pnpm bench:qa -- --upload
 *
 * 环境变量：见 benchmarks/.env.example
 *   加载顺序 benchmarks/.env.local > 根 .env.local > 根 .env（后者不覆盖前者）
 */

// load-env 的副作用在 config 读取 process.env 之前执行
import '../load-env';

import fs from 'fs';
import path from 'path';

import { Client } from 'langsmith';
import defaultConfig, { BenchmarkConfigError, validateEnv } from '../config';
import { computeRunCost } from '../../src/deerflow-harness/runtime/pricing';
import {
  UsageAccumulator,
  mergeRunUsage,
  type RunUsage,
  type TokenUsage,
} from '../../src/deerflow-harness/runtime/usage-accounting';
import { DATASET_V1, toJSONL, toLangSmithFormat } from './dataset';
import { createBenchmarkAgent, type AgentRunResult, type PerformanceMetrics } from './agent';
import {
  SCORE_UNAVAILABLE,
  createDefaultEvaluators,
  type BuiltInEvaluator,
  type EvaluationResult,
} from './evaluators';

// ── CLI 参数解析 ──

function parseArgs(): {
  category?: string;
  id?: string;
  upload: boolean;
  output: string;
  /** 数据集类型：默认 research-qa，可选 longmem */
  dataset?: 'research-qa' | 'longmem';
  /** 显式跳过 LLM judge 评分（此时不再要求 judge 配置，也不产出 llm_judge 指标） */
  noJudge: boolean;
} {
  const args = process.argv.slice(2);
  return {
    category: args.find((a, i) => a === '--category')
      ? args[args.indexOf('--category') + 1]
      : undefined,
    id: args.find((a, i) => a === '--id') ? args[args.indexOf('--id') + 1] : undefined,
    upload: args.includes('--upload'),
    output: args.find((a, i) => a === '--output')
      ? args[args.indexOf('--output') + 1]
      : 'benchmarks/results/research-qa/latest.json',
    dataset: (args.find((a, i) => a === '--dataset')
      ? args[args.indexOf('--dataset') + 1]
      : undefined) as 'research-qa' | 'longmem' | undefined,
    noJudge: args.includes('--no-judge'),
  };
}

// ── 过滤数据集 ──

function filterDataset() {
  const args = parseArgs();
  let filtered = [...DATASET_V1];

  if (args.category) {
    filtered = filtered.filter((ex) => ex.category === args.category);
    console.log(`[Benchmark] 按分类过滤: ${args.category} (${filtered.length} 条)`);
  }
  if (args.id) {
    filtered = filtered.filter((ex) => ex.id === args.id);
    console.log(`[Benchmark] 按 ID 过滤: ${args.id} (${filtered.length} 条)`);
  }

  return { ...args, dataset: filtered };
}

// ── 上传 Dataset 到 LangSmith ──

async function uploadDatasetToLangsmith(
  client: Client,
  config: typeof defaultConfig,
): Promise<void> {
  const examples = toLangSmithFormat(DATASET_V1);
  const datasetName = config.langsmith.datasetName;

  // 尝试创建或更新 dataset
  try {
    await client.createDataset(datasetName);
    console.log(`[Upload] 已创建 Dataset: ${datasetName}`);
  } catch (e: any) {
    if (e.message?.includes('already exists')) {
      console.log(`[Upload] Dataset 已存在: ${datasetName}`);
    } else {
      console.warn('[Upload] 创建 dataset 失败:', e.message);
    }
  }

  // 上传 examples
  let uploaded = 0;
  for (const ex of examples) {
    try {
      await client.createExample(ex.inputs, ex.outputs ?? {}, {
        datasetName,
      });
      uploaded++;
    } catch (e: any) {
      console.warn(`[Upload] 上传失败 (query="${ex.inputs.query.slice(0, 50)}..."):`, e.message);
    }
  }

  console.log(`[Upload] 完成，已上传 ${uploaded}/${examples.length} 条到 LangSmith`);
}

// ── 执行单条测试 ──

async function runSingle(
  agent: ReturnType<typeof createBenchmarkAgent>,
  example: (typeof DATASET_V1)[0],
  evaluators: BuiltInEvaluator[],
): Promise<{
  exampleId: string;
  query: string;
  result: ReportedAgentResult;
  evaluations: EvaluationResult[];
}> {
  console.log(`\n  [Running] ${example.id}: "${example.query.slice(0, 80)}..."`);

  // 执行 agent
  const result = await agent({ query: example.query });

  // 运行评估器
  const evaluations: EvaluationResult[] = [];
  for (const evaluator of evaluators) {
    try {
      // 构建 referenceOutput（可选）
      const refOut =
        example.referenceAnswer || example.expectedKeywords
          ? ({
              ...(example.referenceAnswer ? { referenceAnswer: example.referenceAnswer } : {}),
              ...(example.expectedKeywords ? { expectedKeywords: example.expectedKeywords } : {}),
            } as any)
          : undefined;

      const evalResult = await evaluator.evaluate({
        input: { query: example.query },
        prediction: result,
        referenceOutput: refOut,
      });
      evaluations.push(evalResult);
    } catch (e: any) {
      console.warn(`    [Eval] ${evaluator.name} 失败: ${e.message}`);
      evaluations.push({
        key: evaluator.name,
        score: SCORE_UNAVAILABLE,
        comment: `评估器异常: ${e.message}`,
        metadata: { evaluatorError: true },
      });
    }
  }

  // 打印简要结果
  const status = result.metrics.error ? '❌ ERROR' : '✅ OK';
  const textPreview = result.output.slice(0, 120) + (result.output.length > 120 ? '...' : '');
  console.log(
    `    [${status}] ${result.metrics.totalLatencyMs}ms | ${result.output.length} chars | tools=${result.metrics.toolCallCount}`,
  );
  console.log(`    [Output] ${textPreview}`);

  for (const ev of evaluations) {
    const scoreDisplay = ev.score === SCORE_UNAVAILABLE ? 'N/A' : `${ev.score}`;
    console.log(`    [${ev.key}] ${scoreDisplay} ${ev.comment ? `| ${ev.comment}` : ''}`);
  }

  return {
    exampleId: example.id,
    query: example.query,
    result: toReportedResult(result),
    evaluations,
  };
}

// ── 报告生成 ──

/**
 * 落盘用的 agent 结果 —— **不含原始事件流**。
 *
 * 实测单个 example 的事件数组占报告体积的 **97%**（一条 easy 题就 1840 条事件，
 * 绝大多数是逐 token 的 STREAM_CHUNK）：242KB → 去掉后 6.3KB。全量跑会产出几百 MB
 * 的 JSON，而增量落盘时每批都要重新序列化一遍。事件流没有任何消费方（只在调试时看），
 * 这里只留按类型的计数；细排请看 LangSmith trace。
 */
interface ReportedAgentResult {
  output: string;
  metrics: PerformanceMetrics;
  /** 按事件类型计数，例如 { start: 1, stream_chunk: 1800, tool_call: 3, end: 1 } */
  eventTypes: Record<string, number>;
  /**
   * 该条目的完整用量（含**逐次调用记录**）。
   * 保留逐次记录是必需的：计价依赖每次调用自己的时间戳（高峰/空闲差一倍），
   * 只存总数会让从报告重算费用变得不可能。calls 条目本身很小（约 120B/次）。
   */
  usage?: RunUsage;
}

function toReportedResult(result: AgentRunResult): ReportedAgentResult {
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

interface BenchmarkReport {
  runAt: string;
  config: {
    agentModel: string;
    /** judge **实际**使用的模型；未创建 judge 时为 null（不再照抄配置意图） */
    judgeModel: string | null;
    /** 是否真的创建了 LLM judge 评估器 */
    judgeEnabled: boolean;
    datasetSize: number;
    timeoutMs: number;
  };
  summary: {
    totalExamples: number;
    successCount: number;
    errorCount: number;
    /** 其中因超时中止的条数（基础设施故障，与「答错」分开） */
    timeoutCount: number;
    avgLatencyMs: number;
    avgTtftMs: number;
    /** 各评估器均分。**不可测/失败（-1）不计入**；无有效样本的 key 不出现在这里 */
    avgScores: Record<string, number>;
    /** 各评估器的有效样本数与不可用数 —— 用来判断均分是否可信 */
    scoreCoverage: Record<string, { scored: number; unavailable: number }>;
    /** token 用量与费用（按角色拆分；token 实测，金额按 pricing.json 估算） */
    accounting: AccountingBlock;
  };
  results: Array<{
    exampleId: string;
    query: string;
    result: ReportedAgentResult;
    evaluations: EvaluationResult[];
  }>;
}

/**
 * 报告里的 token 与费用。token 是**实测**，金额是估算 —— 分开列，价格表过期时
 * token 依然可信。
 */
interface AccountingBlock {
  usage: {
    agent: TokenUsage;
    judge: TokenUsage;
    total: TokenUsage;
  };
  cost: {
    currency: string;
    priceAsOf: string;
    priceSource: string;
    agent: number;
    judge: number;
    total: number;
    /** 全部调用若都落在高峰时段的总价（现实上界；空闲价恰为高峰半价） */
    ifAllPeakTotal: number;
    /** 出现在用量里但价格表没有的模型 —— 它们的费用**未**计入上面的数字 */
    unknownModels: string[];
    /** 拿不到用量的调用数（成本被低估）/ 只有粗粒度用量的调用数（被高估） */
    callsMissingUsage: number;
    callsCoarseUsage: number;
  };
}

/** 落盘报告（批次结束即写，避免中途失败丢掉已完成的全部工作）。 */
function writeReport(outputPath: string, report: BenchmarkReport): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8');
}

function generateReport(
  results: BenchmarkReport['results'],
  config: typeof defaultConfig,
  judgeModel: string | null,
): BenchmarkReport {
  const successResults = results.filter((r) => !r.result.metrics.error);

  // 计算平均分：-1（不可测/失败）不计入
  const allEvaluations = results.flatMap((r) => r.evaluations);
  const scoreAccumulator: Record<string, number[]> = {};
  const unavailableCounter: Record<string, number> = {};
  for (const ev of allEvaluations) {
    if (ev.score >= 0) {
      if (!scoreAccumulator[ev.key]) scoreAccumulator[ev.key] = [];
      scoreAccumulator[ev.key].push(ev.score);
    } else {
      unavailableCounter[ev.key] = (unavailableCounter[ev.key] ?? 0) + 1;
    }
  }
  const avgScores: Record<string, number> = {};
  const scoreCoverage: BenchmarkReport['summary']['scoreCoverage'] = {};
  for (const key of new Set([
    ...Object.keys(scoreAccumulator),
    ...Object.keys(unavailableCounter),
  ])) {
    const scores = scoreAccumulator[key] ?? [];
    scoreCoverage[key] = { scored: scores.length, unavailable: unavailableCounter[key] ?? 0 };
    // 无有效样本时**不写入** avgScores。此前会算出 NaN 并被 JSON 序列化成 null，
    // 读报告的人看不出「这个指标根本没算出来」还是「算出来是 0」。
    if (scores.length > 0) {
      avgScores[key] = scores.reduce((s, v) => s + v, 0) / scores.length;
    }
  }

  // 记账：agent 侧来自模型工厂 callback，judge 侧来自评估器就地读取的响应 usage。
  const agentUsage = mergeRunUsage(results.map((r) => r.result.usage));
  const judgeAccumulator = new UsageAccumulator();
  for (const r of results) {
    for (const ev of r.evaluations) {
      const usage = ev.metadata?.usage as TokenUsage | undefined;
      const at = ev.metadata?.at as number | undefined;
      if (!usage || typeof at !== 'number') continue;
      judgeAccumulator.record(`${r.exampleId}:${ev.key}`, {
        modelName: (ev.metadata?.judgeModel as string | undefined) ?? judgeModel ?? 'unknown',
        usage,
        at,
      });
    }
  }
  const judgeUsage = judgeAccumulator.snapshot();
  const totalUsage = mergeRunUsage([agentUsage, judgeUsage]);
  const agentCost = computeRunCost(agentUsage);
  const judgeCost = computeRunCost(judgeUsage);

  return {
    runAt: new Date().toISOString(),
    config: {
      agentModel: config.agent.modelName,
      judgeModel,
      judgeEnabled: judgeModel !== null,
      datasetSize: results.length,
      timeoutMs: config.run.timeoutMs,
    },
    summary: {
      totalExamples: results.length,
      successCount: successResults.length,
      errorCount: results.filter((r) => r.result.metrics.error).length,
      timeoutCount: results.filter((r) => r.result.metrics.errorKind === 'timeout').length,
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
      avgScores,
      scoreCoverage,
      accounting: {
        usage: {
          agent: agentUsage.total,
          judge: judgeUsage.total,
          total: totalUsage.total,
        },
        cost: {
          currency: agentCost.currency,
          priceAsOf: agentCost.priceAsOf,
          priceSource: agentCost.priceSource,
          agent: agentCost.total,
          judge: judgeCost.total,
          total: agentCost.total + judgeCost.total,
          ifAllPeakTotal: agentCost.ifAllPeak + judgeCost.ifAllPeak,
          unknownModels: [...new Set([...agentCost.unknownModels, ...judgeCost.unknownModels])],
          callsMissingUsage: totalUsage.callsMissingUsage,
          callsCoarseUsage: totalUsage.callsCoarseUsage,
        },
      },
    },
    results,
  };
}

function printReport(report: BenchmarkReport): void {
  console.log('\n' + '='.repeat(70));
  console.log('  BENCHMARK REPORT');
  console.log('='.repeat(70));
  console.log(`  Time:       ${report.runAt}`);
  console.log(`  Model:      ${report.config.agentModel}`);
  console.log(`  Judge:      ${report.config.judgeModel ?? '(未启用 —— --no-judge)'}`);
  console.log(`  Dataset:    ${report.config.datasetSize} examples\n`);

  const { summary } = report;

  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │ Summary                                     │');
  console.log('  ├────────────────┬─────────────────────────────┤');
  console.log(`  │ Total          │ ${String(summary.totalExamples).padStart(25)} │`);
  console.log(`  │ Success        │ ${String(summary.successCount).padStart(25)} │`);
  console.log(`  │ Errors         │ ${String(summary.errorCount).padStart(25)} │`);
  if (summary.timeoutCount > 0) {
    console.log(`  │ 其中超时       │ ${String(summary.timeoutCount).padStart(25)} │`);
  }
  console.log(`  │ Avg Latency    │ ${(summary.avgLatencyMs / 1000).toFixed(1).padStart(25)}s │`);
  console.log(`  │ Avg TTFT       │ ${(summary.avgTtftMs / 1000).toFixed(1).padStart(25)}s │`);
  console.log('  └────────────────┴─────────────────────────────┘');

  console.log('\n  Average Scores:');
  for (const [key, score] of Object.entries(summary.avgScores)) {
    const bar = '█'.repeat(Math.round(score * 20));
    const cov = summary.scoreCoverage[key];
    const covNote = cov && cov.unavailable > 0 ? `  (${cov.unavailable} 项不可用)` : '';
    console.log(
      `    ${(key + ':').padEnd(24)} ${(score * 100).toFixed(1).padStart(6)}%  ${bar}${covNote}`,
    );
  }
  // 没有任何有效样本的指标要显式说出来，否则会被读成「这一项满分/零分」
  for (const key of Object.keys(summary.scoreCoverage)) {
    if (!(key in summary.avgScores)) {
      console.log(`    ${(key + ':').padEnd(24)} ${'无有效样本'.padStart(6)}      (未产出均分)`);
    }
  }

  // ── 成本（token 实测，金额按 pricing.json 估算）──
  const { accounting } = summary;
  const yuan = (n: number) => `¥${n.toFixed(4)}`;
  console.log('\n  ┌──────────────────────────────────────────────┐');
  console.log('  │ Token & Cost                                │');
  console.log('  ├────────────────┬─────────────────────────────┤');
  for (const role of ['agent', 'judge'] as const) {
    const u = accounting.usage[role];
    console.log(
      `  │ ${role.padEnd(14)} │ ${`${u.llmCalls} calls, in ${u.inputTokens}（命中 ${u.cacheReadTokens}）/ out ${u.outputTokens}`.padStart(25)} │`,
    );
  }
  console.log(`  │ ${'成本 agent'.padEnd(14)} │ ${yuan(accounting.cost.agent).padStart(25)} │`);
  console.log(`  │ ${'成本 judge'.padEnd(14)} │ ${yuan(accounting.cost.judge).padStart(25)} │`);
  console.log(`  │ ${'成本 合计'.padEnd(14)} │ ${yuan(accounting.cost.total).padStart(25)} │`);
  console.log('  └────────────────┴─────────────────────────────┘');
  console.log(
    `    价格表 ${accounting.cost.priceAsOf}（${accounting.cost.currency}）；全部落在高峰时段则约 ${yuan(
      accounting.cost.ifAllPeakTotal,
    )}`,
  );

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

  console.log('\n' + '='.repeat(70));
}

// ── 主入口 ──

async function main(): Promise<void> {
  const config = defaultConfig;
  const args = parseArgs();

  // ── LongMemEval 路由 ──
  if (args.dataset === 'longmem') {
    console.log('[Benchmark] 检测到 --dataset longmem，切换到 LongMemEval 运行模式...');
    // 动态导入避免未安装数据集时的加载开销
    const longMemModule = await import('../longmem/run');
    const longMemMain = longMemModule.main as () => Promise<void>;
    // 将原始 CLI 参数透传给 longmem/run
    await longMemMain();
    return;
  }

  // 先解析参数再校验：--no-judge 是「显式不评分」的逃生口，校验必须知道它。
  // 缺配置时**抛错中止**，不再静默跳过 judge / 静默改用 agent 模型自评。
  validateEnv({ skipJudge: args.noJudge });

  const { dataset } = filterDataset();

  if (dataset.length === 0) {
    console.error('[Benchmark] 数据集为空，请检查过滤条件');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║         DeepResearch Benchmark Runner        ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Agent Model: ${config.agent.modelName.padStart(30)}║`);
  console.log(
    `║  Judge Model: ${(args.noJudge ? '(--no-judge 跳过)' : config.judge.modelName).padStart(30)}║`,
  );
  console.log(
    `║  Dataset:     ${String(DATASET_V1.length).padStart(30)}条 → ${String(dataset.length).padStart(3)} 条待执行║`,
  );
  console.log(`║  Concurrency: ${String(config.run.concurrency).padStart(30)}║`);
  console.log('╚══════════════════════════════════════════════╝');

  // ── 上传模式 ──
  if (args.upload) {
    const lsClient = new Client({ apiKey: process.env.LANGCHAIN_API_KEY! });
    await uploadDatasetToLangsmith(lsClient, config);
    return;
  }

  // ── 创建 Agent 和评估器 ──
  const agent = createBenchmarkAgent({
    modelName: config.agent.modelName,
    baseUrl: config.agent.baseUrl,
    apiKey: config.agent.apiKey,
    timeoutMs: config.run.timeoutMs,
  });

  // --no-judge 是显式选择；否则 validateEnv 已保证 judge 配置齐全。
  // 不再用 `config.judge.apiKey ? {...} : undefined` 那种「缺了就静默不建 judge」的写法。
  const judgeOptions = args.noJudge
    ? undefined
    : {
        modelName: config.judge.modelName,
        baseUrl: config.judge.baseUrl,
        apiKey: config.judge.apiKey,
        timeoutMs: config.run.timeoutMs,
      };

  const evaluators = createDefaultEvaluators(judgeOptions);
  const judgeModel = evaluators.find((e) => e.name === 'llm_judge') ? config.judge.modelName : null;

  // ── 执行 Benchmark ──
  const startTime = Date.now();
  const results: BenchmarkReport['results'] = [];

  // 并发控制（简单实现：分批）
  const batchSize = config.run.concurrency;
  for (let i = 0; i < dataset.length; i += batchSize) {
    const batch = dataset.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((example) => runSingle(agent, example, evaluators)),
    );
    results.push(...batchResults);
    // 批次落盘：此前报告只在全部跑完后才写，中途失败（异常/超时/手工中断）会
    // 把已完成的全部工作一起丢掉。
    writeReport(args.output, generateReport(results, config, judgeModel));
  }

  // ── 生成报告 ──
  const report = generateReport(results, config, judgeModel);
  printReport(report);

  // 保存结果 JSON（批次结束已增量写过，这里写最终版含收尾统计）
  writeReport(args.output, report);
  console.log(`\n[Report] 结果已保存到 ${args.output}`);

  // 导出数据集为 JSONL（方便后续复用）
  const jsonlPath = args.output.replace('.json', '.jsonl');
  toJSONL(dataset, jsonlPath);

  console.log(`\n[Benchmark] 总耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  // 配置类错误只打印消息：对「忘了配环境变量」这种事，堆栈是纯噪音
  if (e instanceof BenchmarkConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  console.error('[Benchmark] Fatal error:', e);
  process.exit(1);
});
