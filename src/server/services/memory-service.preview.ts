/**
 * 记忆「检索效果预览」的 app 侧入口（*.preview.ts：仅调试/观察接口使用，
 * 不进生产链路）。对应 GET /api/memory/retrieve。
 *
 * 与真实注入走同一段代码（harness 的 injection.preview.ts →
 * retrieveForInjection），前置幂等装配存储后端 + embedding / rerank 工厂
 * （threadService 未初始化时也要能向量化 query 并精排，否则退化为纯词面 +
 * RRF 序预览）。
 */

import { previewMemoryRetrieval, type MemoryRetrievalPreview } from '@/deerflow-harness';
import { ensureMemoryRerankerFactory, ensureMemoryStorage } from '@/server/wiring';

export async function previewRetrieval(
  userId: string,
  query: string,
): Promise<MemoryRetrievalPreview> {
  await ensureMemoryStorage();
  await ensureMemoryRerankerFactory();
  return previewMemoryRetrieval({ agentName: null, userId, query });
}
