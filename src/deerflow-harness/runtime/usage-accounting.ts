/**
 * LLM 用量记账 —— 回答「跑一次到底花了多少钱」的事实依据。
 *
 * 背景：agent 侧的 token 用量此前完全拿不到 —— `client.ts` 从不读 `usage_metadata`，
 * SSE 白名单（`runtime/sse/client-event.ts`）里没有 usage 事件，subagent 又是独立
 * top-level stream、在父图里结构上看不见（而它恰是深研究场景的成本大头）。
 *
 * 方案：在模型工厂（`models/index.ts`）构造 ChatOpenAI 时挂一个 callback handler，
 * 把每次调用的 usage 累加进 **ALS 作用域**里的累加器。一处覆盖 lead + subagent +
 * 中间件里的全部 LLM 调用，且不必改 SSE 协议、不动前端。
 *
 * 两条不变量：
 *
 * 1. **sink 必须在调用时解析**（`currentUsageAccumulator()`），不能在建实例时绑定：
 *    agent 实例有缓存（`client.ts` 的 buildConfigKey）、会跨 run 复用，绑死会把多次
 *    run 的用量混进同一个累加器。
 * 2. **产品路径默认没有 sink**（没人调 `withUsageAccounting`）→ handler 直接返回，
 *    行为与接线前完全一致。
 *
 * 计价注意：`cacheReadTokens` 是 `inputTokens` 的**子集**而非额外量 —— DeepSeek 返回
 * `prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`，
 * `@langchain/openai` 把 `prompt_tokens_details.cached_tokens` 映射成 `cache_read`
 * （completions.js 的 usage 转换）。故未命中量 = inputTokens − cacheReadTokens，
 * 见 `pricing.ts`。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';

/** 单次 LLM 调用的用量。 */
export interface TokenUsage {
  /** 输入 token 总数（含命中缓存的子集）。 */
  inputTokens: number;
  /** 输出 token 总数（含 reasoning 子集）。 */
  outputTokens: number;
  /** 其中命中 prompt cache 的输入 token（inputTokens 的子集，单价通常低两个数量级）。 */
  cacheReadTokens: number;
  /** 其中思考模式产生的 reasoning token（outputTokens 的子集）。 */
  reasoningTokens: number;
  /** 调用次数。 */
  llmCalls: number;
}

/** 一次调用记录。 */
export interface UsageCall {
  modelName: string;
  usage: TokenUsage;
  /** 调用结束时刻（epoch ms）。高峰/空闲单价差一倍，故按每次调用自己的时刻计价。 */
  at: number;
}

/** 一个记账作用域内的汇总。 */
export interface RunUsage {
  total: TokenUsage;
  byModel: Record<string, TokenUsage>;
  calls: UsageCall[];
  /**
   * 完全拿不到 usage 的调用次数 —— 这些调用的 token 没被计入，是**低估**。
   * 用于暴露「记账不完整」，而不是静默出一个偏小的数字。
   */
  callsMissingUsage: number;
  /**
   * 只拿到粗粒度用量（仅有 prompt/completion 总数、无 cache/reasoning 明细）的调用
   * 次数 —— 这些调用的缓存命中无法体现，是**高估**成本。正常走 OpenAI 兼容流式响应
   * 时该值应为 0。
   */
  callsCoarseUsage: number;
}

export function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    llmCalls: 0,
  };
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    llmCalls: a.llmCalls + b.llmCalls,
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** LangChain `usage_metadata` 的结构子集。 */
interface UsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { cache_read?: number };
  output_token_details?: { reasoning?: number };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * DeepSeek 原生 usage 字段。
 *
 * 流式响应里 `response_metadata.usage` 保留原始 JSON，含 `prompt_cache_hit_tokens`。
 * 需要它作兜底：`@langchain/openai` 只从 `prompt_tokens_details.cached_tokens` 映射
 * `input_token_details.cache_read`，且判断是 `!== null`（undefined 也能通过），于是
 * 拿不到标准字段时 `input_token_details` 会是个空对象而不是报错 —— 命中缓存的部分
 * 就会被按未命中价计费，**成本最多高估 50 倍且毫无提示**。
 */
function cacheReadFromResponseMetadata(responseMetadata: unknown): number {
  if (!isObject(responseMetadata)) return 0;
  const usage = responseMetadata.usage;
  if (!isObject(usage)) return 0;
  const nativeHit = num(usage.prompt_cache_hit_tokens);
  if (nativeHit > 0) return nativeHit;
  const details = usage.prompt_tokens_details;
  return isObject(details) ? num(details.cached_tokens) : 0;
}

function usageFromMetadata(meta: UsageMetadata, cacheReadFallback = 0): TokenUsage | undefined {
  const inputTokens = num(meta.input_tokens);
  const outputTokens = num(meta.output_tokens);
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  const cacheReadTokens = num(meta.input_token_details?.cache_read) || cacheReadFallback;
  return {
    inputTokens,
    outputTokens,
    // 夹到 inputTokens 以内：cache_read 是 input 的子集，上游若按 chunk 重复累加
    // usage 就可能超过 input，不夹会让 cacheMiss 变负数、把成本算小。
    cacheReadTokens: Math.min(cacheReadTokens, inputTokens),
    reasoningTokens: num(meta.output_token_details?.reasoning),
    llmCalls: 1,
  };
}

/**
 * 从 `handleLLMEnd` 的 LLMResult 提取用量。
 *
 * 主数据源是 generation 上的 `message.usage_metadata`（**只有它带 cache_read /
 * reasoning 明细**）；`llmOutput.tokenUsage` 是 LangChain 流式路径留下的粗粒度兜底
 * （仅 promptTokens/completionTokens/totalTokens），拿它时缓存命中会算不出来。
 */
export function tokenUsageFromLLMResult(output: LLMResult): {
  usage?: TokenUsage;
  coarse?: TokenUsage;
} {
  const generations = Array.isArray(output?.generations) ? output.generations : [];
  const merged = emptyTokenUsage();
  let found = false;

  for (const genList of generations) {
    for (const gen of genList ?? []) {
      const message = isObject(gen) ? gen.message : undefined;
      const meta = isObject(message) ? (message.usage_metadata as UsageMetadata) : undefined;
      if (!meta) continue;
      const usage = usageFromMetadata(
        meta,
        cacheReadFromResponseMetadata(isObject(message) ? message.response_metadata : undefined),
      );
      if (!usage) continue;
      merged.inputTokens += usage.inputTokens;
      merged.outputTokens += usage.outputTokens;
      merged.cacheReadTokens += usage.cacheReadTokens;
      merged.reasoningTokens += usage.reasoningTokens;
      found = true;
    }
  }

  if (found) {
    // 一次 handleLLMEnd 对应一次调用，即使 n>1 有多条 generation。
    merged.llmCalls = 1;
    return { usage: merged };
  }

  const tokenUsage = isObject(output?.llmOutput) ? output.llmOutput.tokenUsage : undefined;
  if (isObject(tokenUsage)) {
    const inputTokens = num(tokenUsage.promptTokens);
    const outputTokens = num(tokenUsage.completionTokens);
    if (inputTokens > 0 || outputTokens > 0) {
      return {
        coarse: {
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          reasoningTokens: 0,
          llmCalls: 1,
        },
      };
    }
  }

  return {};
}

/**
 * 从一条消息的 `usage_metadata` 提取用量。
 *
 * 供 benchmark 侧直接读取 judge 响应使用 —— judge 模型是各 benchmark 自己 `new
 * ChatOpenAI(...)` 建的（不走模型工厂），因此没有 callback 记账，只能就地把响应上的
 * usage 抠出来。
 */
export function tokenUsageFromUsageMetadata(
  meta: unknown,
  responseMetadata?: unknown,
): TokenUsage | undefined {
  if (!isObject(meta)) return undefined;
  return usageFromMetadata(meta as UsageMetadata, cacheReadFromResponseMetadata(responseMetadata));
}

/** 把逐次调用记录汇总成 RunUsage（累加器与合并函数共用同一套口径）。 */
function aggregate(calls: UsageCall[], missingUsage: number, coarseUsage: number): RunUsage {
  const total = emptyTokenUsage();
  const byModel: Record<string, TokenUsage> = {};

  for (const call of calls) {
    const key = call.modelName || 'unknown';
    byModel[key] = addTokenUsage(byModel[key] ?? emptyTokenUsage(), call.usage);
    total.inputTokens += call.usage.inputTokens;
    total.outputTokens += call.usage.outputTokens;
    total.cacheReadTokens += call.usage.cacheReadTokens;
    total.reasoningTokens += call.usage.reasoningTokens;
    total.llmCalls += call.usage.llmCalls;
  }

  return {
    total,
    byModel,
    calls: [...calls],
    callsMissingUsage: missingUsage,
    callsCoarseUsage: coarseUsage,
  };
}

/** 一个记账作用域内的累加器。 */
export class UsageAccumulator {
  private readonly calls: UsageCall[] = [];
  /**
   * 已记账的 LLM runId，用于去重。
   *
   * 实测确认挂到构造处的 callback 是 **local、非继承**的（`CallbackManager.configure`
   * 走 `.copy(localHandlers, false)`），所以常规路径不会重复上报。保留去重是为了兜住
   * 非常规来源：自建网关/代理把 usage 分段重复下发、或某个实例被重复挂到同一次 run 上 ——
   * 这类重复一旦发生就是费用翻倍，且从报告上看不出来。
   */
  private readonly seenRunIds = new Set<string>();
  private missingUsage = 0;
  private coarseUsage = 0;

  /** 首次见到该 runId 返回 true；重复事件返回 false。 */
  private claim(runId: string): boolean {
    if (!runId) return true;
    if (this.seenRunIds.has(runId)) return false;
    this.seenRunIds.add(runId);
    return true;
  }

  record(runId: string, call: UsageCall): void {
    if (!this.claim(runId)) return;
    this.calls.push(call);
  }

  recordCoarse(runId: string, call: UsageCall): void {
    if (!this.claim(runId)) return;
    this.coarseUsage += 1;
    this.calls.push(call);
  }

  recordMissing(runId: string): void {
    if (!this.claim(runId)) return;
    this.missingUsage += 1;
  }

  snapshot(): RunUsage {
    return aggregate([...this.calls], this.missingUsage, this.coarseUsage);
  }
}

/**
 * 合并多段用量（如「每条题目的 agent 用量」→ 整套件用量）。
 *
 * 保留逐次调用记录而不是只加总数：计价依赖每次调用**自己的时间戳**（高峰/空闲差一倍），
 * 只留总数就没法正确计价了。
 */
export function mergeRunUsage(list: Array<RunUsage | undefined>): RunUsage {
  const calls: UsageCall[] = [];
  let missingUsage = 0;
  let coarseUsage = 0;

  for (const item of list) {
    if (!item) continue;
    calls.push(...item.calls);
    missingUsage += item.callsMissingUsage;
    coarseUsage += item.callsCoarseUsage;
  }

  return aggregate(calls, missingUsage, coarseUsage);
}

const usageAls = new AsyncLocalStorage<UsageAccumulator>();

/** 当前记账作用域的累加器；不在作用域内（如产品正常对话）返回 undefined。 */
export function currentUsageAccumulator(): UsageAccumulator | undefined {
  return usageAls.getStore();
}

/**
 * 在带记账的作用域里跑 `fn`，返回其结果与该作用域内的用量汇总。
 *
 * 作用域内**所有**经模型工厂创建的 LLM 调用都会计入，包括 subagent（它们是独立
 * top-level stream，但仍在同一 async 上下文里，ALS 自动向下传递）与中间件自身的
 * 调用（标题生成、记忆更新、摘要等）。
 *
 * 可用于包住一次 agent run，也可包住一整个阶段（如 LongMemEval 的 ingest）。
 */
export async function withUsageAccounting<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; usage: RunUsage }> {
  const accumulator = new UsageAccumulator();
  const result = await usageAls.run(accumulator, fn);
  return { result, usage: accumulator.snapshot() };
}

/**
 * 挂在模型实例上的用量记账 handler。
 *
 * 由模型工厂在构造 `ChatOpenAI` 时以 `callbacks: [new UsageRecordingHandler(modelName)]`
 * 注入；每次调用结束（`handleLLMEnd`）把用量记进当前 ALS 作用域的累加器。没有作用域
 * 时是 no-op。
 */
export class UsageRecordingHandler extends BaseCallbackHandler {
  override name = 'deerflow-usage-recording';

  constructor(private readonly modelName: string) {
    super();
  }

  override handleLLMEnd(output: LLMResult, runId: string): void {
    const accumulator = currentUsageAccumulator();
    if (!accumulator) return;

    const { usage, coarse } = tokenUsageFromLLMResult(output);
    if (usage) {
      accumulator.record(runId, { modelName: this.modelName, usage, at: Date.now() });
      return;
    }
    if (coarse) {
      accumulator.recordCoarse(runId, { modelName: this.modelName, usage: coarse, at: Date.now() });
      return;
    }
    accumulator.recordMissing(runId);
  }
}
