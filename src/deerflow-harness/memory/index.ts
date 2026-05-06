/**
 * Memory Module — deerflow-harness
 *
 * 对话记忆/上下文管理（预留模块）
 *
 * @module deerflow-harness/memory
 */

/**
 * 记忆提供者接口
 *
 * 未来实现时，MemoryProvider 将支持对话历史的持久化存储、
 * 上下文窗口管理、以及长期记忆的检索。
 */
export interface MemoryProvider {
  /** 提供者名称 */
  name: string;
  /** 保存记忆 */
  save(key: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
  /** 检索记忆 */
  retrieve(query: string, limit?: number): Promise<MemoryEntry[]>;
  /** 清除记忆 */
  clear(key?: string): Promise<void>;
}

/** 记忆条目 */
export interface MemoryEntry {
  key: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
  relevanceScore?: number;
}
