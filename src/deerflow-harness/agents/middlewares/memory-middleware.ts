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

/**
 * MemoryMiddleware（位序 9 / features.memory 启用）
 *
 * 行为（对齐 Python `agents/middlewares/memory_middleware.py`）：
 * - afterAgent 阶段：在一次 agent 运行完成后，把消息历史投递到 memory queue，
 *   由 queue debounce + LLM updater 异步落盘。
 * - 上传消息已在 message-processing 中剥离，filterMessagesForMemory 之后还需要
 *   `hasUserAndAi` 守卫，避免空 turn / 工具结果 turn 触发更新。
 * - thread_id / user_id 从 RuntimeContext（AsyncLocalStorage）取，agentName 从
 *   runtime.context（如有）取，找不到时记为 null（global memory）。
 *
 * 注意：本中间件**只入队**，绝不在 hook 内 await LLM 调用，避免阻塞主流程。
 */
export const memoryMiddleware = createMiddleware({
  name: 'MemoryMiddleware',
  afterAgent: async (state: any, runtime: any) => {
    try {
      const cfg = getMemoryConfig();
      if (!cfg.enabled) return undefined;

      const messages = Array.isArray(state?.messages) ? state.messages : [];
      const filtered = filterMessagesForMemory(messages);
      if (!hasUserAndAi(filtered)) return undefined;

      const ctx = getContext();
      const threadId =
        ctx?.thread_id ??
        (runtime?.config?.configurable?.thread_id as string | undefined) ??
        '';
      if (!threadId) return undefined;

      const userId =
        ctx?.user_id ??
        ((runtime?.context as any)?.userId as string | undefined) ??
        null;

      // 优先从 runtime.context.agentName 读，其次为 null（=> global memory）
      const agentName = ((runtime?.context as any)?.agentName as string | undefined) ?? null;

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
