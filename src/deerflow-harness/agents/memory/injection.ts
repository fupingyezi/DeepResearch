/**
 * 记忆注入（生产链路）：`buildMemoryContext` 与检索模式的共用实现。
 *
 * `retrieveForInjection` 同时被检索效果预览（injection.preview.ts）调用——
 * 预览看到的（打分明细 / 注入文本）与实际拼进 system prompt 的是同一段代码的
 * 产物，不会漂移。预览代码独立在 *.preview.ts，不进生产链路。
 */

import { getMemoryConfig } from './config';
import { backfillMemoryEmbeddings, embedQuery } from './embeddings';
import { formatMemoryForInjection } from './prompt';
import { rerankWithFallback } from './rerank';
import { retrieveMemory, type RetrieveResult } from './retrieval';
import { getMemoryStorage, type VectorSearchResult } from './storage';
import type { MemoryData } from './types';

export interface BuildMemoryContextOptions {
  agentName?: string | null;
  userId?: string | null;
  /**
   * 注入模式：
   * - 'inject'（默认）：全量注入所有 section 与预算内 facts；
   * - 'retrieve'：按 query 检索相关 facts / section，用更小预算注入。
   */
  mode?: 'inject' | 'retrieve';
  /** retrieve 模式的语义 query（当前轮用户输入；resume 无本轮文本时由历史顶替）。 */
  query?: string;
  /** 近 N 轮人类输入（旧→新）；仅参与词面 query 拼接，不参与向量化。 */
  recentQueries?: string[];
}

interface RetrieveForInjectionOutcome {
  queryEmbedding: number[] | null;
  /** 真正会拼进 system prompt 的整段文本；空串 = 不注入。 */
  injectedText: string;
  /** 管线全量产物（打分明细 / poolSize / rerankUsed / vectorLeg），供预览同源消费。 */
  result: RetrieveResult | null;
}

/**
 * 检索模式的共用实现：`buildMemoryContext` 与注入预览（injection.preview.ts）
 * 都走这里，保证「预览看到的」与「实际注入的」是同一段代码的产物、不会漂移。
 * 导出仅供预览模块使用（生产链路只有 buildMemoryContext 一个入口）；
 * collectTrace 时在管线产物里附上明细组装所需的中间产物快照（trace）。
 */
export async function retrieveForInjection(
  data: MemoryData,
  opts: {
    agentName: string | null;
    userId: string | null;
    query: string;
    recentQueries?: string[];
  },
  collectTrace = false,
): Promise<RetrieveForInjectionOutcome> {
  const config = getMemoryConfig();
  // 词面 query = 近 N 轮拼接（去重：resume 时语义 query 即最近一轮，不重复计入）；
  // 语义 query 只取当前轮——拼串会稀释句向量语义，语义门槛标定基于单句。
  const lexicalQuery = [...(opts.recentQueries ?? []), opts.query]
    .map((s) => (s ?? '').trim())
    .filter((s, i, arr) => Boolean(s) && arr.indexOf(s) === i)
    .join('\n');

  // 语义检索：query 一次性向量化（无 Key / 失败 → null，回落纯词面）；
  // 顺手 fire-and-forget 回填缺失向量的旧数据（内部 in-flight 去重，不阻塞本次检索）。
  let queryEmbedding: number[] | null = null;
  if (config.embeddingEnabled) {
    queryEmbedding = await embedQuery(opts.query);
    if (queryEmbedding && config.embeddingBackfillEnabled) {
      void backfillMemoryEmbeddings({ agentName: opts.agentName, userId: opts.userId });
    }
  }

  // 管线 deps：vectorRecall 来自 storage 后端（PG 走 pgvector；无后端时
  // 管线内部回落 JS 扫描）；rerank 走 rerankWithFallback（工厂缺失 / API 失败
  // 返回 null，管线保持 RRF 序）。rerankQuery 用本轮单句——拼串会稀释语义。
  const storage = getMemoryStorage();
  const vectorRecall: ((q: number[], n: number) => Promise<VectorSearchResult[]>) | null =
    storage.vectorSearch
      ? (queryVector, limit) =>
          // 必须经 storage 接收者调用：解构后裸调用会丢 this（toScope 挂在实例上）
          storage.vectorSearch!(
            { agentName: opts.agentName, userId: opts.userId },
            queryVector,
            limit,
          )
      : null;
  const result = await retrieveMemory(data, lexicalQuery, {
    topK: config.retrieveTopK,
    queryEmbedding,
    semanticMatchThreshold: config.semanticMatchThreshold,
    vectorRecall,
    rerank: config.rerankEnabled ? rerankWithFallback : null,
    rerankQuery: opts.query.trim() ? opts.query : undefined,
    collectTrace,
  });

  const pickedText = result
    ? formatMemoryForInjection(result.picked, config.retrieveMaxTokens, {
        preserveFactOrder: true,
      })
    : '';
  return {
    queryEmbedding,
    injectedText: pickedText.trim() ? `<memory mode="retrieve">\n${pickedText}\n</memory>\n` : '',
    result,
  };
}

/**
 * 加载 memory 并格式化为 `<memory>...</memory>\n` 字符串，便于直接拼到 system
 * prompt。配置关闭、内容为空或读取异常时一律返回空字符串。
 */
export async function buildMemoryContext(opts: BuildMemoryContextOptions = {}): Promise<string> {
  try {
    const config = getMemoryConfig();
    if (!config.enabled || !config.injectionEnabled) {
      console.warn('[memory] early return: config disabled');
      return '';
    }
    const data = await getMemoryStorage().load({
      agentName: opts.agentName ?? null,
      userId: opts.userId ?? null,
    });

    // retrieve 模式：先按 query 收敛出相关子集，再用更小的预算格式化。
    // query 无信号或全部落空 → 不注入，避免无关记忆干扰模型。
    if (opts.mode === 'retrieve') {
      const outcome = await retrieveForInjection(data, {
        agentName: opts.agentName ?? null,
        userId: opts.userId ?? null,
        query: opts.query ?? '',
        recentQueries: opts.recentQueries,
      });
      return outcome.injectedText;
    }

    const text = formatMemoryForInjection(data, config.maxInjectionTokens);
    if (!text.trim()) return '';
    return `<memory>\n${text}\n</memory>\n`;
  } catch (e) {
    console.error('[memory] Failed to build memory context:', e);
    return '';
  }
}
