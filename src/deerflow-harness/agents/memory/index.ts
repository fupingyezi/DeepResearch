/**
 * Memory subsystem 公共门面 —— 与 Python `agents/memory/__init__.py` 对齐。
 *
 * 上层（lead-agent prompt builder / memoryMiddleware / HTTP API）应仅依赖本文件。
 */

export type {
  Fact,
  FactCategory,
  HistorySection,
  MemoryData,
  SectionData,
  UserSection,
} from './types';
export { createEmptyMemory, utcNowIsoZ, validateAgentName, AGENT_NAME_PATTERN } from './types';

export type { MemoryConfig } from './config';
export {
  DEFAULT_MEMORY_CONFIG,
  getMemoryConfig,
  loadMemoryConfigFromDict,
  setMemoryConfig,
} from './config';

export {
  agentMemoryFile,
  getBaseDir,
  memoryFile,
  userAgentMemoryFile,
  userMemoryFile,
} from './paths';

export type { MemoryStorage } from './storage';
export { FileMemoryStorage, getMemoryStorage, resetMemoryStorage } from './storage';

export {
  countTokens,
  formatConversationForUpdate,
  formatMemoryForInjection,
  MEMORY_UPDATE_PROMPT,
  setTokenCounter,
  type TokenCounter,
} from './prompt';

export {
  detectCorrection,
  detectReinforcement,
  filterMessagesForMemory,
  hasUserAndAi,
} from './message-processing';

export {
  clearMemoryData,
  createMemoryFact,
  deleteMemoryFact,
  getMemoryData,
  getMemoryModelFactory,
  importMemoryData,
  MemoryUpdater,
  reloadMemoryData,
  setMemoryModelFactory,
  updateMemoryFact,
  updateMemoryFromConversation,
  type MemoryModelFactory,
  type UpdateMemoryOptions,
} from './updater';

export {
  getMemoryQueue,
  MemoryUpdateQueue,
  resetMemoryQueue,
  type AddArgs,
  type ConversationContext,
} from './queue';

import { getMemoryConfig as _gmc } from './config';
import { getMemoryStorage as _gms } from './storage';
import { formatMemoryForInjection as _fmt } from './prompt';

export interface BuildMemoryContextOptions {
  agentName?: string | null;
  userId?: string | null;
}

/**
 * 加载 memory 并格式化为 `<memory>...</memory>\n` 字符串，便于直接拼到 system
 * prompt。配置关闭、内容为空或读取异常时一律返回空字符串。
 */
export async function buildMemoryContext(opts: BuildMemoryContextOptions = {}): Promise<string> {
  try {
    const config = _gmc();
    if (!config.enabled || !config.injectionEnabled) return '';
    const data = await _gms().load({
      agentName: opts.agentName ?? null,
      userId: opts.userId ?? null,
    });
    const text = _fmt(data, config.maxInjectionTokens);
    if (!text.trim()) return '';
    return `<memory>\n${text}\n</memory>\n`;
  } catch (e) {
    console.error('[memory] Failed to build memory context:', e);
    return '';
  }
}
