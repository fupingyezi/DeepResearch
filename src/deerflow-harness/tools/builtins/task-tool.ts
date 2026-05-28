import { tool } from 'langchain';
import z from 'zod';
import { v4 as uuidv4 } from 'uuid';

import { SubagentExecutor, getSubagentConfig, getAvailableSubagentNames } from '../../subagents';
import type { SubagentConfig } from '../../subagents';
import { getContext } from '../../runtime/context';
import type { SubagentEvent } from '../../types';

/**
 * task tool —— 事件委派核心
 *
 * Lead agent 通过 `task("general-purpose", ...)` 把任务委派给 subagent。
 * 本工具：
 * 1) 校验 subagent_type 与配置
 * 2) 装载 subagent 自己的工具集：
 *    - cfg.tools=undefined → 继承 lead 工具集（subagentEnabled=false 防递归）
 *    - cfg.tools=string[]  → 仅装载白名单
 *    - 再按 cfg.disabledTools 黑名单过滤
 * 3) 创建 SubagentExecutor 并消费其 AsyncIterable<SubagentEvent>；
 *    通过 RuntimeContext.currentModelConfig 把 lead 当前 ModelConfig 透传给
 *    'inherit' 模式的 subagent。
 * 4) 把每个 SubagentEvent 翻译成 task_* 事件，通过 LangGraph custom writer 推到上游
 * 5) 终态返回字符串结果给 lead LLM
 */

const TaskInputSchema = z.object({
  description: z.string().min(1).describe('任务的简短描述（3-5 个词），用于日志/前端展示。'),
  prompt: z.string().min(1).describe('给 subagent 的任务描述，需具体且自包含。'),
  subagent_type: z
    .string()
    .min(1)
    .describe('subagent 类型，目前可用："general-purpose"。'),
  max_turns: z.number().int().positive().optional().describe('可选：覆盖 subagent 最大轮次。'),
  task_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      '可选：稳定的任务 ID（如 "task-1"），用于前端把多次 task_* 事件合并到同一条目。' +
        '不传时退化为 LangChain 内部 toolCallId。',
    ),
});

/**
 * 把 SubagentEvent 翻译成 LangGraph custom writer 推送的 task_* 事件 payload。
 *
 * @param ev          subagent executor 流出的事件
 * @param description task tool 调用方（lead-agent）传入的任务标题
 * @param publicTaskId 推送给前端的 task_id：优先使用 lead 透传的 task_id，
 *                    否则退化为 SubagentExecutor 内部的 taskId（即 LangChain toolCallId）。
 */
function toWriterPayload(
  ev: SubagentEvent,
  description: string,
  publicTaskId: string,
): Record<string, any> {
  switch (ev.kind) {
    case 'started':
      return {
        type: 'task_started',
        task_id: publicTaskId,
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
    const cfgObj = (runtime?.config ?? runtime ?? {}) as Record<string, any>;
    const parentSignal: AbortSignal | undefined =
      (runtime?.signal as AbortSignal | undefined) ?? (cfgObj.signal as AbortSignal | undefined);
    const writer: ((p: any) => void) | undefined =
      (runtime?.writer as ((p: any) => void) | undefined) ??
      (cfgObj.writer as ((p: any) => void) | undefined);
    const toolCallId: string =
      (runtime?.toolCall?.id as string | undefined) ??
      (runtime?.toolCallId as string | undefined) ??
      uuidv4().slice(0, 8);

    const publicTaskId = task_id ?? toolCallId;

    // ---- 3) 装载 subagent 内部工具集 --------------------------------------
    // - cfg.tools=undefined：继承 lead 默认工具集
    // - cfg.tools=string[]：白名单
    // 始终强制 subagentEnabled=false，杜绝 subagent 再调用 task。
    const { getAvailableTools } = await import('../index');
    const inherited = await getAvailableTools({
      groups: cfg.tools, // undefined → 全集
      subagentEnabled: false,
    });

    // 黑名单过滤（防递归 + 业务隔离）
    const disabled = new Set(cfg.disabledTools ?? []);
    // 始终强制屏蔽 task，防止白名单 / 自定义 disabledTools 漏配。
    disabled.add('task');
    const tools = inherited.filter(
      (t) => !disabled.has((t as { name?: string }).name ?? ''),
    );

    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[taskTool] subagent="${cfg.name}" tools=[${tools
          .map((t) => (t as { name?: string }).name ?? '?')
          .join(', ')}] (inherited=${inherited.length}, disabled=[${[...disabled].join(', ')}])`,
      );
    }

    // ---- 4) 创建 executor 并消费事件流 ------------------------------------
    // 透传 lead 当前 ModelConfig：仅当 cfg.model='inherit' 时被使用
    const inheritedModelConfig = getContext()?.currentModelConfig;
    const executor = new SubagentExecutor({
      config: cfg,
      tools,
      taskId: toolCallId,
      inheritedModelConfig,
    });

    const safeWriter = (payload: any) => {
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
    } catch (err: any) {
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
      'Available subagent types are returned by the registry (currently: "general-purpose").',
    schema: TaskInputSchema,
  },
);
