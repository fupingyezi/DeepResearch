#!/usr/bin/env tsx
/**
 * Benchmark 主执行脚本
 *
 * 用法（从项目根目录执行）：
 *   npx tsx benchmarks/run.ts
 *   npx tsx benchmarks/run.ts --category multi-hop
 *   npx tsx benchmarks/run.ts --id fact-001
 *   npx tsx benchmarks/run.ts --upload
 *
 * 环境变量：见 benchmarks/.env.example
 *   自动加载 benchmarks/.env.local（优先）或 .env.local（fallback）
 */

// ⚠️ 必须是第一个 import：ES import 会 hoist 到顶部，
// load-env 的副作用在 config 读取 process.env 之前执行
import './load-env';

import { Client } from 'langsmith';
import defaultConfig, { validateEnv } from './config';
import { DATASET_V1, toJSONL, toLangSmithFormat } from './datasets/research-qa';
import { createBenchmarkAgent, type AgentRunResult } from './agent-wrapper';
import {
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
      : 'benchmarks/results/latest.json',
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
  result: AgentRunResult;
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
        score: -1,
        comment: `评估器异常: ${e.message}`,
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
    const scoreDisplay = ev.score === -1 ? 'N/A' : `${ev.score}`;
    console.log(`    [${ev.key}] ${scoreDisplay} ${ev.comment ? `| ${ev.comment}` : ''}`);
  }

  return {
    exampleId: example.id,
    query: example.query,
    result,
    evaluations,
  };
}

// ── 报告生成 ──

interface BenchmarkReport {
  runAt: string;
  config: {
    agentModel: string;
    judgeModel: string;
    datasetSize: number;
  };
  summary: {
    totalExamples: number;
    successCount: number;
    errorCount: number;
    avgLatencyMs: number;
    avgTtftMs: number;
    avgScores: Record<string, number>;
  };
  results: Array<{
    exampleId: string;
    query: string;
    result: AgentRunResult;
    evaluations: EvaluationResult[];
  }>;
}

function generateReport(
  results: BenchmarkReport['results'],
  config: typeof defaultConfig,
): BenchmarkReport {
  const successResults = results.filter((r) => !r.result.metrics.error);

  // 计算平均分（排除异常值 -1）
  const allEvaluations = results.flatMap((r) => r.evaluations);
  const scoreAccumulator: Record<string, number[]> = {};
  for (const ev of allEvaluations) {
    if (!scoreAccumulator[ev.key]) scoreAccumulator[ev.key] = [];
    if (ev.score >= 0) scoreAccumulator[ev.key].push(ev.score);
  }
  const avgScores: Record<string, number> = {};
  for (const key of Object.keys(scoreAccumulator)) {
    const scores = scoreAccumulator[key];
    avgScores[key] = scores.reduce((s, v) => s + v, 0) / scores.length;
  }

  return {
    runAt: new Date().toISOString(),
    config: {
      agentModel: config.agent.modelName,
      judgeModel: config.judge.modelName,
      datasetSize: results.length,
    },
    summary: {
      totalExamples: results.length,
      successCount: successResults.length,
      errorCount: results.filter((r) => r.result.metrics.error).length,
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
    },
    results,
  };
}

function printReport(report: BenchmarkReport): void {
  console.log('\n' + '='.repeat(70));
  console.log('  BENCHMARK REPORT');
  console.log('='.repeat(70));
  console.log(`  Time:       ${report.runAt}`);
  console.log(`  Model:      ${report.config.agentModel} (Judge: ${report.config.judgeModel})`);
  console.log(`  Dataset:    ${report.config.datasetSize} examples\n`);

  const { summary } = report;

  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │ Summary                                     │');
  console.log('  ├────────────────┬─────────────────────────────┤');
  console.log(`  │ Total          │ ${String(summary.totalExamples).padStart(25)} │`);
  console.log(`  │ Success        │ ${String(summary.successCount).padStart(25)} │`);
  console.log(`  │ Errors         │ ${String(summary.errorCount).padStart(25)} │`);
  console.log(`  │ Avg Latency    │ ${(summary.avgLatencyMs / 1000).toFixed(1).padStart(25)}s │`);
  console.log(`  │ Avg TTFT       │ ${(summary.avgTtftMs / 1000).toFixed(1).padStart(25)}s │`);
  console.log('  └────────────────┴─────────────────────────────┘');

  console.log('\n  Average Scores:');
  for (const [key, score] of Object.entries(summary.avgScores)) {
    const bar = '█'.repeat(Math.round(score * 20));
    console.log(`    ${(key + ':').padEnd(24)} ${(score * 100).toFixed(1).padStart(6)}%  ${bar}`);
  }

  console.log('\n' + '='.repeat(70));
}

// ── 主入口 ──

async function main(): Promise<void> {
  validateEnv();

  const config = defaultConfig;
  const args = parseArgs();
  const { dataset } = filterDataset();

  if (dataset.length === 0) {
    console.error('[Benchmark] 数据集为空，请检查过滤条件');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     mini-DeepResearch Benchmark Runner        ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Agent Model: ${config.agent.modelName.padStart(30)}║`);
  console.log(`║  Judge Model: ${config.judge.modelName.padStart(30)}║`);
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
  });

  const judgeOptions = config.judge.apiKey
    ? {
        modelName: config.judge.modelName,
        baseUrl: config.judge.baseUrl,
        apiKey: config.judge.apiKey,
      }
    : undefined;

  const evaluators = createDefaultEvaluators(judgeOptions);

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
  }

  // ── 生成报告 ──
  const report = generateReport(results, config);
  printReport(report);

  // 保存结果 JSON
  const fs = require('fs');
  const path = require('path');
  const dir = path.dirname(args.output);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(args.output, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\n[Report] 结果已保存到 ${args.output}`);

  // 导出数据集为 JSONL（方便后续复用）
  const jsonlPath = args.output.replace('.json', '.jsonl');
  toJSONL(dataset, jsonlPath);

  console.log(`\n[Benchmark] 总耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('[Benchmark] Fatal error:', e);
  process.exit(1);
});
