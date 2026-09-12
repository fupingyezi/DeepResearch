/**
 * Benchmark 配置文件
 *
 * 使用前请设置环境变量：
 *   LANGCHAIN_TRACING_V2=true
 *   LANGCHAIN_API_KEY=your-langsmith-api-key  (从 https://smith.langchain.com 获取)
 *   LANGSMITH_PROJECT=mini-deepresearch-benchmark
 */

export interface BenchmarkConfig {
  // LangSmith 配置
  langsmith: {
    project: string;
    datasetName: string;
  };

  // Agent 配置 (对齐 src/deerflow-harness/models/index.ts)
  agent: {
    modelName: string;
    baseUrl?: string;
    apiKey?: string; // 从环境变量读取
  };

  // LLM-as-Judge 配置 (用于评估输出质量)
  judge: {
    modelName: string; // 推荐 gpt-4o 或 claude-3-5-sonnet
    baseUrl?: string;
    apiKey?: string; // 从环境变量读取
  };

  // 运行配置
  run: {
    /** 并发数（建议 1-3，避免 API 限流） */
    concurrency: number;
    /** 单次请求超时 (ms) */
    timeoutMs: number;
    /** 是否启用详细日志 */
    verbose: boolean;
  };
}

/** 默认配置 */
export const defaultConfig: BenchmarkConfig = {
  langsmith: {
    project: process.env.LANGSMITH_PROJECT ?? 'mini-deepresearch-benchmark',
    datasetName: 'deep-research-qa-v1',
  },
  // Agent 配置 (对齐 src/deerflow-harness/models/index.ts)
  agent: {
    /** 默认 deepseek-flash（官方名，GET /models 只返回 deepseek-flash 与 deepseek-v4-pro） */
    modelName: process.env.BENCHMARK_AGENT_MODEL ?? 'deepseek-flash',
    /** 默认读取 DEEPSEEK_BASE_URL */
    baseUrl: process.env.BENCHMARK_AGENT_BASE_URL ?? process.env.DEEPSEEK_BASE_URL,
    /** 默认读取 DEEPSEEK_API_KEY */
    apiKey: process.env.BENCHMARK_AGENT_API_KEY ?? process.env.DEEPSEEK_API_KEY,
  },
  judge: {
    /** 与 agent 同族时默认 v4-pro；换别家 judge 记得同时改 baseUrl */
    modelName: process.env.BENCHMARK_JUDGE_MODEL ?? 'deepseek-v4-pro',
    /** ⚠️ 刻意**不**回落到 DEEPSEEK_BASE_URL：judge 与 agent 可以是不同供应商 */
    baseUrl: process.env.BENCHMARK_JUDGE_BASE_URL,
    apiKey: process.env.BENCHMARK_JUDGE_API_KEY,
  },
  run: {
    concurrency: parseInt(process.env.BENCHMARK_CONCURRENCY ?? '2', 10),
    timeoutMs: parseInt(process.env.BENCHMARK_TIMEOUT_MS ?? '300000', 10),
    verbose: process.env.BENCHMARK_VERBOSE === 'true',
  },
};

export default defaultConfig;

// ── 环境变量校验 ──

/**
 * 配置类错误（而非程序缺陷）。顶层 catch 只打印消息、不打印堆栈 ——
 * 对「忘了配环境变量」这种事，堆栈是纯噪音。
 */
export class BenchmarkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkConfigError';
  }
}

export interface ValidateEnvOptions {
  /** 显式跳过评分（--no-judge）时为 true —— 此时不再要求 judge 配置。 */
  skipJudge?: boolean;
}

/**
 * 校验环境变量。**缺失即抛错中止**，不再静默降级。
 *
 * 为什么是硬失败：以下缺失在历史实现里的行为都是「悄悄换个东西继续跑」，产出的数字看着
 * 正常但含义已经变了 ——
 *   - judge key 缺失 → research-qa 干脆不创建 LLM judge（报告却仍打印 judge 模型名）；
 *                      longmem 改用 agent 模型自评。
 *   - judge baseUrl 缺失 → 请求带着 DeepSeek key 打到 api.openai.com，judge 全部失败，
 *                          而失败被计成 0 分平均进结果里。
 * 想显式不评分请用 `--no-judge`，把「静默降级」变成「显式选择」。
 *
 * 抛错而非直接 exit：便于单测，也让调用方统一走自己的顶层错误处理（均为 exit 1）。
 */
export function validateEnv(opts: ValidateEnvOptions = {}): void {
  const problems: string[] = [];
  const { agent, judge } = defaultConfig;

  if (!agent.apiKey) {
    problems.push('BENCHMARK_AGENT_API_KEY 为空，且未从 DEEPSEEK_API_KEY 取到值');
  }
  if (!agent.baseUrl) {
    problems.push(
      'BENCHMARK_AGENT_BASE_URL 为空，且未从 DEEPSEEK_BASE_URL 取到值（留空会打到 api.openai.com）',
    );
  }

  if (!opts.skipJudge) {
    if (!judge.apiKey) {
      problems.push(
        'BENCHMARK_JUDGE_API_KEY 为空 —— judge 侧没有 DEEPSEEK_* 回落，必须显式配置（可与 agent 共用同一把 key）',
      );
    }
    if (!judge.baseUrl) {
      problems.push(
        'BENCHMARK_JUDGE_BASE_URL 为空 —— judge 侧不会回落到 DEEPSEEK_BASE_URL，漏配会把请求打到 api.openai.com',
      );
    }
  }

  if (problems.length > 0) {
    throw new BenchmarkConfigError(
      '[Benchmark] 环境变量不完整，已中止（避免产出无法解释的分数）：\n  - ' +
        problems.join('\n  - ') +
        '\n参考 benchmarks/.env.example；若确认本次不需要评分，请显式加 --no-judge。',
    );
  }

  // LangSmith 缺失只告警：本地跑不需要它，只有 --upload 与在 UI 里看 trace 才用得上。
  const langsmithMissing: string[] = [];
  // langsmith 两个名字都认，任一存在即可（避免对用新名字的配置误报）
  if (!process.env.LANGCHAIN_TRACING_V2 && !process.env.LANGSMITH_TRACING) {
    langsmithMissing.push('LANGCHAIN_TRACING_V2=true（或 LANGSMITH_TRACING=true）');
  }
  if (!process.env.LANGCHAIN_API_KEY) {
    langsmithMissing.push('LANGCHAIN_API_KEY');
  }
  if (langsmithMissing.length > 0) {
    console.warn(
      '[Benchmark] 未配置 LangSmith（可选），本次不会有 trace 可查看：\n  ' +
        langsmithMissing.join('\n  ') +
        '\n参考 benchmarks/.env.example',
    );
  }
}
