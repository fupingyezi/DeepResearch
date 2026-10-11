import { createMiddleware } from 'langchain';

import { getMemoryConfig } from '../memory/config';
import {
  detectCorrection,
  detectReinforcement,
  filterMessagesForMemory,
  hasUserAndAi,
} from '../memory/message-processing';
import { getMemoryQueue } from '../memory/queue';
import { getContext } from '../../runtime/context';

interface RuntimeContextLike {
  userId?: string;
  agentName?: string;
}

/**
 * MemoryMiddleware
 *
 * - afterAgent 阶段：把消息历史投递到 memory queue，由 queue debounce + LLM
 *   updater 异步落盘。
 * - 上传消息已在 message-processing 中剥离，filterMessagesForMemory 之后还需
 *   `hasUserAndAi` 守卫，避免空 turn / 工具结果 turn 触发更新。
 * - thread_id / user_id / agent_name 优先从 RuntimeContext（AsyncLocalStorage）取，
 *   失败时回退到 LangGraph `runtime.context`。
 *
 * 本中间件**只入队**，绝不在 hook 内 await LLM 调用，避免阻塞主流程。
 */
export const memoryMiddleware = createMiddleware({
  name: 'MemoryMiddleware',
  afterAgent: async (state: any, runtime: any) => {
    try {
      const config = getMemoryConfig();
      if (!config.enabled) return undefined;

      const messages = Array.isArray(state?.messages) ? state.messages : [];
      const filtered = filterMessagesForMemory(messages);
      if (!hasUserAndAi(filtered)) return undefined;

      const ctx = getContext();
      const threadId =
        ctx?.thread_id ?? (runtime?.config?.configurable?.thread_id as string | undefined) ?? '';
      if (!threadId) return undefined;

      const runtimeContext: RuntimeContextLike = runtime?.context ?? {};
      const userId = ctx?.user_id ?? runtimeContext.userId ?? null;

      const agentName = ctx?.agent_name ?? runtimeContext.agentName ?? null;

      const correction = detectCorrection(filtered);
      const reinforcement = detectReinforcement(filtered);

      getMemoryQueue().add({
        threadId,
        messages: filtered,
        agentName,
        userId,
        correctionDetected: correction,
        reinforcementDetected: reinforcement,
      });
    } catch (e) {
      // memory 任何异常都不应该影响主流程
      console.error('[memoryMiddleware] afterAgent error:', e);
    }
    return undefined;
  },
});
