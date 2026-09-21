/**
 * 记忆域服务：fact CRUD / 检索预览 / 注入模式偏好。
 *
 * 约定（与注入侧、异步写入侧一致）：全部操作走「跨 agent 全局 per-user」
 * 记忆（agentName=null → users/{userId}/memory.json），对齐 deer-flow 2.0
 * 默认对话 agent_name=None 行为。
 *
 * 行为冻结点：
 * - category / confidence 的非法值静默回落默认（'context' / 0.6），不 400
 *   —— 现状如此，前端设置页不做前置校验
 * - fact 不存在的识别靠 updater 的 `fact not found: <id>` 错误文案，
 *   映射为 MEMORY_FACT_NOT_FOUND（404），不做 message 全文匹配以外的魔法
 */

import {
  clearMemoryData,
  createMemoryFact,
  deleteMemoryFact,
  getMemoryData,
  previewMemoryRetrieval,
  updateMemoryFact,
  type FactCategory,
  type MemoryData,
} from '@/deerflow-harness';
import { getMemoryMode, setMemoryMode, type MemoryInjectionMode } from '@deerflow-harness/auth';
import { AppError } from '@/server/http';
import { ensureMemoryEmbeddingsFactory } from '@/server/wiring';

/** fact 分类白名单（单一出处：facts 路由新建与更新共用）。 */
export const VALID_CATEGORIES = new Set<FactCategory>([
  'preference',
  'knowledge',
  'context',
  'behavior',
  'goal',
  'correction',
]);

/** 服务级默认：与 client.ts 的 baseOptions.memoryMode 保持一致。 */
const DEFAULT_MODE: MemoryInjectionMode = 'inject';

/** 把非法 category 回落为默认 'context'（现状行为，不 400）。 */
export function normalizeFactCategory(raw: string | undefined): FactCategory {
  return VALID_CATEGORIES.has(raw as FactCategory) ? (raw as FactCategory) : 'context';
}

/** 把非法 confidence 回落为默认 0.6（现状行为，不 400）。 */
export function normalizeConfidence(raw: number | undefined): number {
  return typeof raw === 'number' && raw >= 0 && raw <= 1 ? raw : 0.6;
}

/** updater 对「fact 不存在」抛出的错误文案前缀。 */
function isFactNotFound(e: unknown): boolean {
  return e instanceof Error && e.message.includes('fact not found');
}

export interface CreateMemoryFactInput {
  content: string;
  category?: string;
  confidence?: number;
}

export interface UpdateMemoryFactInput {
  content?: string;
  category?: string;
  confidence?: number;
}

export interface MemoryServiceDeps {
  read: typeof getMemoryData;
  clear: typeof clearMemoryData;
  createFact: typeof createMemoryFact;
  updateFact: typeof updateMemoryFact;
  deleteFact: typeof deleteMemoryFact;
  preview: typeof previewMemoryRetrieval;
  getMode: typeof getMemoryMode;
  setMode: typeof setMemoryMode;
}

export class MemoryService {
  constructor(private readonly deps: MemoryServiceDeps) {}

  /** 读取当前用户记忆（结构化 summary + facts）。 */
  async getMemory(userId: string): Promise<MemoryData> {
    return this.deps.read(null, userId);
  }

  /** 清空当前用户记忆。 */
  async clearMemory(userId: string): Promise<MemoryData> {
    return this.deps.clear(null, userId);
  }

  /** 新建 fact（来源 manual）。category / confidence 非法值回落默认。 */
  async createFact(userId: string, input: CreateMemoryFactInput): Promise<MemoryData> {
    return this.deps.createFact(
      input.content,
      normalizeFactCategory(input.category),
      normalizeConfidence(input.confidence),
      null,
      userId,
    );
  }

  /** 更新 fact：仅 patch 合法字段；fact 不存在 → MEMORY_FACT_NOT_FOUND。 */
  async updateFact(
    userId: string,
    factId: string,
    input: UpdateMemoryFactInput,
  ): Promise<MemoryData> {
    const patch: { content?: string; category?: FactCategory; confidence?: number } = {};
    if (input.content !== undefined) patch.content = input.content;
    if (input.category !== undefined && VALID_CATEGORIES.has(input.category as FactCategory)) {
      patch.category = input.category as FactCategory;
    }
    if (input.confidence !== undefined && input.confidence >= 0 && input.confidence <= 1) {
      patch.confidence = input.confidence;
    }

    try {
      return await this.deps.updateFact(factId, patch, null, userId);
    } catch (e) {
      if (isFactNotFound(e)) {
        throw new AppError('Memory fact not found', 'MEMORY_FACT_NOT_FOUND', 404);
      }
      throw e;
    }
  }

  /** 删除 fact；fact 不存在 → MEMORY_FACT_NOT_FOUND。 */
  async deleteFact(userId: string, factId: string): Promise<MemoryData> {
    try {
      return await this.deps.deleteFact(factId, null, userId);
    } catch (e) {
      if (isFactNotFound(e)) {
        throw new AppError('Memory fact not found', 'MEMORY_FACT_NOT_FOUND', 404);
      }
      throw e;
    }
  }

  /**
   * 检索模式效果预览：与真实注入走同一段代码。
   * 前置幂等注册 embedding 工厂（threadService 未初始化时也要能向量化 query，
   * 否则退化为纯词面预览）。
   */
  async previewRetrieval(userId: string, query: string): Promise<unknown> {
    ensureMemoryEmbeddingsFactory();
    return this.deps.preview({ agentName: null, userId, query });
  }

  /** 注入模式偏好（未设置过 → inject + isDefault 标记）。 */
  async getMode(userId: string): Promise<{ mode: MemoryInjectionMode; isDefault: boolean }> {
    const stored = await this.deps.getMode(userId);
    return { mode: stored ?? DEFAULT_MODE, isDefault: stored === null };
  }

  async setMode(userId: string, mode: MemoryInjectionMode): Promise<void> {
    await this.deps.setMode(userId, mode);
  }
}

const defaultDeps: MemoryServiceDeps = {
  read: getMemoryData,
  clear: clearMemoryData,
  createFact: createMemoryFact,
  updateFact: updateMemoryFact,
  deleteFact: deleteMemoryFact,
  preview: previewMemoryRetrieval,
  getMode: getMemoryMode,
  setMode: setMemoryMode,
};

/**
 * 工厂 + 模块级懒单例。无跨请求可变状态（状态都在 harness 的 memory storage
 * 注册表里），模块级单例即可，无需 globalThis。
 */
export function createMemoryService(deps: MemoryServiceDeps = defaultDeps): MemoryService {
  return new MemoryService(deps);
}

let _memoryService: MemoryService | null = null;
export function getMemoryService(): MemoryService {
  if (!_memoryService) _memoryService = createMemoryService();
  return _memoryService;
}
