import { tool } from 'langchain';
import z from 'zod';
import { randomUUID } from 'node:crypto';

import { SubagentExecutor, getSubagentConfig, getAvailableSubagentNames } from '../../subagents';
import type { SubagentConfig } from '../../subagents';
import type { SubagentEvent } from '../../types';

/**
 * task tool —— 事件委派核心
 *
 * Lead agent 通过 `task("research", ...)` 把任务委派给 subagent。
 * 本工具：
 * 1) 校验 subagent_type 与配置
 * 2) 装载 subagent 自己的工具集（强制 subagentEnabled=false 防递归）
 * 3) 创建 SubagentExecutor 并消费其 AsyncIterable<SubagentEvent>
 * 4) 把每个 SubagentEvent 翻译成 task_* 事件，通过 LangGraph custom writer 推到上游
 * 5) 终态返回字符串结果给 lead LLM
 */

const TaskInputSchema = z.object({
  description: z.string().min(1).describe('任务的简短描述（3-5 个词），用于日志/前端展示。'),
  prompt: z.string().min(1).describe('给 subagent 的任务描述，需具体且自包含。'),
  subagent_type: z.string().min(1).describe('subagent 类型，如 "research"。'),
  max_turns: z.number().int().positive().optional().describe('可选：覆盖 subagent 最大轮次。'),
  task_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      '可选：plan 阶段（emit_plan）已声明的任务 ID（如 "task-1"）。' +
        '在 plan-mode 中**强烈建议传入**，否则前端"任务划分"列表无法把本次 task 的进度合并到 plan 已展示的对应条目上，会出现 plan 标题被覆盖或新增重复条目的现象。',
    ),
});

/**
 * 把 SubagentEvent 翻译成 LangGraph custom writer 推送的 task_* 事件 payload。
 *
 * @param ev          subagent executor 流出的事件
 * @param description task tool 调用方（lead-agent）传入的任务标题（plan 同条任务的 description）
 * @param publicTaskId 推送给前端的 task_id：优先使用 lead 通过 `task_id` 字段透传的 plan taskId，
 *                    否则退化为 SubagentExecutor 内部的 taskId（即 LangChain toolCallId）。
 *                    保持 publicTaskId 在所有阶段（started/running/completed）一致，前端 store
 *                    才能按它做 partial upsert，正确合并到 plan 阶段已展示的任务条目上。
 */
function toWriterPayload(
  ev: SubagentEvent,
  description: string,
  publicTaskId: string,
): Record<string, unknown> {
  switch (ev.kind) {
    case 'started':
      return {
        type: 'task_started',
        task_id: publicTaskId,
        // 优先采用 task tool 调用方（lead-agent）传入的 `description`——它是
        // plan 里那条具体任务的简短标题（如"研究蜂鸟最高飞行时速"）。
        // 而 `ev.description` 来自 SubagentExecutor 的 `started` 帧，里面塞的是
        // subagent 的 `config.description`（subagent 的自我介绍，对所有任务都一样），
        // 把它当 description 推到前端会把"任务划分"里每条任务的标题都洗成同一段
        // "深度研究子 agent。当用户问题需要联网搜索..."的模板字符串。
        description: description || ev.description,
        subagent_type: ev.subagentType,
      };
    case 'ai_message':
      return {
        type: 'task_running',
        task_id: publicTaskId,
        message: ev.message,
        message_index: ev.index,
        total_messages: ev.total,
      };
    case 'completed':
      return { type: 'task_completed', task_id: publicTaskId, result: ev.result };
    case 'failed':
      return { type: 'task_failed', task_id: publicTaskId, error: ev.error };
    case 'timed_out':
      return { type: 'task_timed_out', task_id: publicTaskId, error: ev.error };
    case 'cancelled':
      return { type: 'task_cancelled', task_id: publicTaskId, error: ev.error };
  }
}

export const taskTool = tool(
  async (input, runtime: any) => {
    const { description, prompt, subagent_type, max_turns, task_id } = input;

    // ---- 1) 校验 subagent type --------------------------------------------
    const found = getSubagentConfig(subagent_type);
    if (!found) {
      const available = getAvailableSubagentNames().join(', ') || '(none)';
      return `Error: Unknown subagent type "${subagent_type}". Available: ${available}`;
    }
    let cfg: SubagentConfig = found;
    if (max_turns != null) {
      cfg = { ...cfg, maxTurns: max_turns };
    }

    // ---- 2) 从 runtime 中提取 signal / writer / toolCallId ---------------
    // LangChain JS tool runtime 形态因版本而异，按兼容顺序探测：
    //   - runtime.signal | runtime.config?.signal
    //   - runtime.writer | runtime.config?.writer
    //   - runtime.toolCall?.id | runtime.toolCallId
    const cfgObj = (runtime?.config ?? runtime ?? {}) as Record<string, unknown>;
    const parentSignal: AbortSignal | undefined =
      (runtime?.signal as AbortSignal | undefined) ?? (cfgObj.signal as AbortSignal | undefined);
    const writer: ((p: unknown) => void) | undefined =
      (runtime?.writer as ((p: unknown) => void) | undefined) ??
      (cfgObj.writer as ((p: unknown) => void) | undefined);
    const toolCallId: string =
      (runtime?.toolCall?.id as string | undefined) ??
      (runtime?.toolCallId as string | undefined) ??
      randomUUID().slice(0, 8);

    // 推给前端的 publicTaskId：优先采用 lead-agent 传入的 plan taskId（保证与
    // emit_plan tasks_initial 阶段同一条任务在前端 store 里 upsert 成功），缺省退回
    // 内部 toolCallId。executor 仍用 toolCallId 作为它的内部 taskId（避免影响 LangGraph
    // 内部链路），二者解耦。
    const publicTaskId = task_id ?? toolCallId;

    // ---- 3) 装载 subagent 内部工具集（subagentEnabled=false 防递归） ------
    const { getAvailableTools } = await import('../index');
    const tools = await getAvailableTools({
      groups: cfg.tools,
      subagentEnabled: false,
    });

    // ---- 4) 创建 executor 并消费事件流 ------------------------------------
    const executor = new SubagentExecutor({
      config: cfg,
      tools,
      taskId: toolCallId,
    });

    const safeWriter = (payload: unknown) => {
      try {
        writer?.(payload);
      } catch (err) {
        // writer 异常不应中断主流程
        console.warn('[taskTool] writer push failed:', err);
      }
    };

    let lastResult: string | null = null;
    let terminalKind: SubagentEvent['kind'] | null = null;
    let terminalError: string | null = null;

    try {
      for await (const ev of executor.execute(prompt, parentSignal)) {
        safeWriter(toWriterPayload(ev, description, publicTaskId));

        switch (ev.kind) {
          case 'completed':
            terminalKind = 'completed';
            lastResult = ev.result;
            break;
          case 'failed':
            terminalKind = 'failed';
            terminalError = ev.error;
            break;
          case 'timed_out':
            terminalKind = 'timed_out';
            terminalError = ev.error;
            break;
          case 'cancelled':
            terminalKind = 'cancelled';
            terminalError = ev.error ?? 'cancelled';
            break;
          // started / ai_message：不影响终态
        }
      }
    } catch (err: unknown) {
      // executor 一般会先 yield 终态再 return，不应抛到这里。
      // 兜底：catch AbortError 等异常时再补一条 cancelled 事件，并以失败形式返回。
      const aborted = parentSignal?.aborted || (err as Error)?.name === 'AbortError';
      if (aborted) {
        safeWriter({ type: 'task_cancelled', task_id: publicTaskId, error: 'parent aborted' });
        return 'Task cancelled by user.';
      }
      const msg = err instanceof Error ? err.message : String(err);
      safeWriter({ type: 'task_failed', task_id: publicTaskId, error: msg });
      return `Task failed. Error: ${msg}`;
    }

    // ---- 5) 终态文案返回给 lead LLM ---------------------------------------
    switch (terminalKind) {
      case 'completed':
        return `Task Succeeded. Result: ${lastResult ?? '(empty)'}`;
      case 'failed':
        return `Task failed. Error: ${terminalError ?? 'unknown error'}`;
      case 'timed_out':
        return `Task timed out. Error: ${terminalError ?? 'timeout'}`;
      case 'cancelled':
        return 'Task cancelled by user.';
      default:
        // 没收到任何终态——理论上不应发生
        return 'Task ended without a terminal status.';
    }
  },
  {
    name: 'task',
    description:
      'Delegate a sub-task to a specialized subagent that runs in its own context. ' +
      'Use it for complex multi-step research, isolated context, or parallel exploration. ' +
      'Available subagent types are returned by the registry.',
    schema: TaskInputSchema,
  },
);
