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
    /** 默认 deepseek-chat，与项目 createChatModel() 保持一致 */
    modelName: process.env.BENCHMARK_AGENT_MODEL ?? 'deepseek-chat',
    /** 默认读取 DEEPSEEK_BASE_URL */
    baseUrl: process.env.BENCHMARK_AGENT_BASE_URL ?? process.env.DEEPSEEK_BASE_URL,
    /** 默认读取 DEEPSEEK_API_KEY */
    apiKey: process.env.BENCHMARK_AGENT_API_KEY ?? process.env.DEEPSEEK_API_KEY,
  },
  judge: {
    modelName: process.env.BENCHMARK_JUDGE_MODEL ?? 'gpt-4o',
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

export function validateEnv(): void {
  const missing: string[] = [];
  if (!process.env.LANGCHAIN_TRACING_V2) {
    missing.push('LANGCHAIN_TRACING_V2=true');
  }
  if (!process.env.LANGCHAIN_API_KEY) {
    missing.push('LANGCHAIN_API_KEY');
  }

  if (missing.length > 0) {
    console.warn(
      '[Benchmark] 缺少以下环境变量，LangSmith tracing 将不可用：\n  ' +
        missing.join('\n  ') +
        '\n请参考 benchmarks/.env.example 配置',
    );
  }
}
