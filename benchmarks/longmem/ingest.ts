/**
 * LongMemEval 记忆「写入」阶段（two-phase 评测的第 1 阶段）
 *
 * 与 prefix 模式（把全部历史直接拼进 prompt）不同，这里真正走长期记忆系统：
 *   逐个 haystack session → 交给 MemoryUpdater 用 LLM 抽取事实/摘要 → 落盘到
 *   users/{userId}/memory.json。提问阶段不再注入历史，而是让 lead-agent 从
 *   存储的记忆里检索作答，从而端到端考察「记忆写入 → 存储 → 跨 session 检索」能力。
 *
 * 关键约束：
 *   - 每个 example 用独立 userId → 独立记忆文件 → 题目之间互不污染。
 *   - 同一 example 的多个 session 必须「串行」写入（共享同一文件，读-改-写不能并发）。
 *   - 需先注入 memory model factory，否则 MemoryUpdater 是空操作（no-op）。
 */

import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';

import {
  createChatModel,
  setMemoryModelFactory,
  updateMemoryFromConversation,
  clearMemoryData,
  getMemoryData,
  type ModelConfig,
} from '../../src/deerflow-harness';
import type { LongMemExample, LongMemSessionMessage } from './dataset';

/** 记忆写入阶段的逐 example 统计 */
export interface IngestStats {
  /** 已处理的 session 数 */
  sessionsProcessed: number;
  /** 成功写入的 session 数（updater 返回 true） */
  sessionsWritten: number;
  /** 落盘后记忆中的 fact 总数 */
  factCount: number;
  /** 写入耗时 (ms) */
  ingestMs: number;
}

let _factoryInstalled = false;

/**
 * 注入 memory model factory（全局只需一次）。
 *
 * MemoryUpdater 通过 factory 拿到 chat model 来做事实抽取。这里复用 agent 的
 * deepseek 配置，并强制非流式 + 低温度（抽取任务要稳定、确定性高）。
 */
export function installMemoryModelFactory(config: {
  modelName: string;
  baseUrl?: string;
  apiKey?: string;
}): void {
  if (_factoryInstalled) return;
  setMemoryModelFactory(() =>
    createChatModel({
      modelName: config.modelName,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      streaming: false,
      maxTokens: 8192,
      temperature: 0.2,
      topP: 0.8,
    } as ModelConfig),
  );
  _factoryInstalled = true;
  console.log(`[Ingest] 已注入 memory model factory（抽取模型: ${config.modelName}）`);
}

/** 为单个 example 生成稳定且文件名安全的 userId */
export function exampleUserId(example: LongMemExample): string {
  const safe = example.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `longmem_${safe}`;
}

/** 把 LongMemEval 的一个 session 转成 LangChain 消息数组 */
function sessionToMessages(session: LongMemSessionMessage[]): BaseMessage[] {
  const msgs: BaseMessage[] = [];
  for (const m of session) {
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content.trim()) continue;
    if (m.role === 'user') {
      msgs.push(new HumanMessage(content));
    } else {
      msgs.push(new AIMessage(content));
    }
  }
  return msgs;
}

/**
 * 写入阶段：把一个 example 的全部 haystack sessions 逐个喂进记忆系统。
 *
 * @param example  数据集条目（含 raw.haystack_sessions）
 * @param userId   该 example 的隔离 userId
 * @param onProgress 可选进度回调（已处理 session 数 / 总数）
 */
export async function ingestExample(
  example: LongMemExample,
  userId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<IngestStats> {
  const start = Date.now();

  // 干净起点：清空该 user 的历史记忆，确保题目之间不串味
  await clearMemoryData(null, userId);

  const sessions = example.raw.haystack_sessions ?? [];
  let processed = 0;
  let written = 0;

  for (let i = 0; i < sessions.length; i++) {
    const messages = sessionToMessages(sessions[i]);
    processed++;
    // session 内既无 user 也无 assistant 有效内容时跳过（updater 也会自行兜底）
    if (messages.length === 0) {
      onProgress?.(processed, sessions.length);
      continue;
    }

    const threadId = `${userId}__s${i + 1}`;
    const ok = await updateMemoryFromConversation(messages, {
      threadId,
      userId,
      agentName: null,
    });
    if (ok) written++;
    onProgress?.(processed, sessions.length);
  }

  // 读取落盘后的 fact 总数作为「记忆体量」指标
  let factCount = 0;
  try {
    const data = await getMemoryData(null, userId);
    factCount = Array.isArray(data.facts) ? data.facts.length : 0;
  } catch {
    factCount = 0;
  }

  return {
    sessionsProcessed: processed,
    sessionsWritten: written,
    factCount,
    ingestMs: Date.now() - start,
  };
}
