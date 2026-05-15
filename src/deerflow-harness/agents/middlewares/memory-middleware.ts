import { createMiddleware } from 'langchain';

/**
 * MemoryMiddleware（位序 9 / features.memory 启用）
 *
 * 职责（占位）：
 * - beforeModel：检索相关长期记忆并注入 system prompt / 上下文；
 * - afterAgent：抽取本次会话要点，写入向量库 / KV。
 */
export const memoryMiddleware = createMiddleware({
  name: 'MemoryMiddleware',
});
