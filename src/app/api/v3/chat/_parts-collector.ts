/**
 * AssistantPartsCollector
 *
 * 把后端 SSE 流（ClientAgentEvent）实时聚合为 assistant message 的 parts[]，
 * 在 END 时由 v3/chat 路由的 wrapWithPersistence 调用 finalize() 拿到落库结构。
 *
 * 合并规则（与前端 stream-chat-handler 等价）：
 * - 连续 stream_chunk.text     → 合并到一个 text part 的 content.text
 * - 连续 stream_chunk.reasoning → 合并到一个 reasoning part 的 content.text
 * - text/reasoning 被其它类型 part 打断后，再次出现需新建 part
 * - tool_call → push tool_call part；TOOL_RESULT 通过 toolCallId 反查 tool_call
 *   part 把 status / result / success / errorMessage 写回（极端时序错乱时作为
 *   独立 tool_result part 兜底）
 * - subagent_task：upsert by taskId；reasoning 累积；children 维护工具调用 history
 * - state_update.report → push artifact part
 * - HUMAN_INTERRUPT → 写顶层 interrupt（不入 parts）
 * - START / END / HEARTBEAT → 不入 parts
 *
 * finalize 阶段：调用与前端共享的 extractFinalMessageParts，把 lead 最终消息里
 * 符合「研究报告」结构（H1 + ≥2 个 H2）的 markdown 段落整段提升为 artifact，
 * `<task_summary>` 块解析为 task_summary part；多 agent 工作流时若模型未输出
 * `<task_summary>`，从 subagent_task parts 派生兜底总结。确保持久化（reload）
 * 与实时流式（live）两端结构一致。
 *
 * 设计要点：
 * - partIndexByToolCallId / partIndexByTaskId 双 Map 让反查 O(1)
 * - lastPartType 跟踪上一个 part 的类型，避免把"其他 part 之后的 text"误并入
 *   旧 text part
 */

import { v4 as uuidv4 } from 'uuid';

import type {
  ClientAgentEvent,
  ClientAgentEventType,
  TaskProgressPayload,
} from '@deerflow-harness/runtime/sse/client-event';
import { ClientAgentEventType as Et } from '@deerflow-harness/runtime/sse/client-event';
import type { ChatMessageType, MessagePart, SubagentToolCall } from '@/types';
import { extractFinalMessageParts } from '@/utils/chat/final-message-extract';
import { parseJsonSafe, hasMeaningfulArgs, isObjectWithKey } from '@/utils/common';

type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;
type SubagentTaskPart = Extract<MessagePart, { type: 'subagent_task' }>;

export class AssistantPartsCollector {
  private parts: MessagePart[] = [];
  private lastPartType: MessagePart['type'] | null = null;
  private partIndexByToolCallId = new Map<string, number>();
  private partIndexByTaskId = new Map<string, number>();
  private interrupt: ChatMessageType['interrupt'] = null;

  onEvent(event: ClientAgentEvent): void {
    switch (event.eventType) {
      case Et.STREAM_CHUNK: {
        const { text, reasoning } = event.payload;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          this.appendOrMergeReasoning(reasoning);
        }
        if (typeof text === 'string' && text.length > 0) {
          this.appendOrMergeText(text);
        }
        break;
      }

      case Et.TOOL_CALL: {
        this.pushToolCall(event.payload);
        break;
      }

      case Et.TOOL_RESULT: {
        this.attachToolResult(event.payload);
        break;
      }

      case Et.TASK_PROGRESS: {
        this.upsertSubagentTask(event.payload);
        break;
      }

      case Et.STATE_UPDATE: {
        this.applyStateUpdate(event.payload.stateType, event.payload.data);
        break;
      }

      case Et.HUMAN_INTERRUPT: {
        this.interrupt = {
          question: event.payload.question,
          details: event.payload.details,
        };
        break;
      }

      case Et.START:
      case Et.END:
      case Et.HEARTBEAT:
      case Et.ERROR:
        // ERROR 不入 parts；调用方在 catch 中按需处理
        break;

      default: {
        const _never: never = event;
        void _never;
      }
    }
  }

  finalize(fallbackTitle = ''): { parts: MessagePart[]; interrupt: ChatMessageType['interrupt'] } {
    const parts = extractFinalMessageParts(this.parts, fallbackTitle);
    return { parts, interrupt: this.interrupt };
  }

  private appendOrMergeText(text: string): void {
    const idx = this.findMergeTarget('text');
    if (idx >= 0) {
      const last = this.parts[idx] as Extract<MessagePart, { type: 'text' }>;
      last.content.text += text;
      this.lastPartType = 'text';
      return;
    }
    this.parts.push({
      partId: uuidv4(),
      type: 'text',
      createdAt: Date.now(),
      content: { text },
    });
    this.lastPartType = 'text';
  }

  private appendOrMergeReasoning(text: string): void {
    const idx = this.findMergeTarget('reasoning');
    if (idx >= 0) {
      const last = this.parts[idx] as Extract<MessagePart, { type: 'reasoning' }>;
      last.content.text += text;
      this.lastPartType = 'reasoning';
      return;
    }
    this.parts.push({
      partId: uuidv4(),
      type: 'reasoning',
      createdAt: Date.now(),
      content: { text },
    });
    this.lastPartType = 'reasoning';
  }

  /**
   * 自尾向前找可合并的同类型 part 下标；穿过 subagent_task / tool_call /
   * tool_result（lead 在等待并行 task 工具时，TASK_PROGRESS 会反复 upsert
   * 同一个 subagent_task part，与 lead 自身的 reasoning chunk 交替到达）；
   * 一旦遇到另一个文本类 part（text/reasoning 中的另一种）则视为段落边界。
   */
  private findMergeTarget(target: 'text' | 'reasoning'): number {
    const other = target === 'text' ? 'reasoning' : 'text';
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const t = this.parts[i].type;
      if (t === target) return i;
      if (t === other) return -1;
      if (t === 'subagent_task' || t === 'tool_call' || t === 'tool_result') continue;
      return -1;
    }
    return -1;
  }

  private pushToolCall(payload: {
    toolCallId: string;
    toolName: string;
    arguments?: string;
  }): void {
    const args = parseJsonSafe(payload.arguments);
    const part: ToolCallPart = {
      partId: uuidv4(),
      type: 'tool_call',
      createdAt: Date.now(),
      content: {
        toolCallId: payload.toolCallId,
        name: payload.toolName,
        args,
        status: 'running',
      },
    };
    this.parts.push(part);
    this.partIndexByToolCallId.set(payload.toolCallId, this.parts.length - 1);
    this.lastPartType = 'tool_call';
  }

  private attachToolResult(payload: {
    toolCallId: string;
    toolName: string;
    result: unknown;
    success: boolean;
    errorMessage?: string;
  }): void {
    const idx = this.partIndexByToolCallId.get(payload.toolCallId);
    if (typeof idx === 'number') {
      const target = this.parts[idx];
      if (target && target.type === 'tool_call') {
        target.content.result = payload.result;
        target.content.success = payload.success;
        target.content.errorMessage = payload.errorMessage;
        target.content.status = payload.success === false ? 'failed' : 'done';
        return;
      }
    }
    // 时序错乱兜底：先收到 result 而无对应 tool_call → 独立 tool_result part
    this.parts.push({
      partId: uuidv4(),
      type: 'tool_result',
      createdAt: Date.now(),
      content: {
        toolCallId: payload.toolCallId,
        result: payload.result,
        success: payload.success,
        errorMessage: payload.errorMessage,
      },
    });
    this.lastPartType = 'tool_result';
  }

  private upsertSubagentTask(payload: TaskProgressPayload): void {
    const taskId = payload.taskId ?? '';
    const status = payload.status ?? 'running';

    if (status === 'tool_call' || status === 'tool_result') {
      this.applySubagentToolEvent(taskId, payload, status);
      return;
    }

    const idx = this.partIndexByTaskId.get(taskId);
    const prev = typeof idx === 'number' ? (this.parts[idx] as SubagentTaskPart) : null;

    const incomingReasoning =
      typeof payload.reasoning === 'string' && payload.reasoning.length > 0
        ? payload.reasoning
        : undefined;
    const prevReasoning = prev?.content.reasoning ?? '';
    const nextReasoning = incomingReasoning
      ? prevReasoning + incomingReasoning
      : prevReasoning || undefined;

    const next: SubagentTaskPart = {
      partId: prev?.partId ?? uuidv4(),
      type: 'subagent_task',
      createdAt: prev?.createdAt ?? Date.now(),
      content: {
        taskId,
        description:
          typeof payload.description === 'string' ? payload.description : prev?.content.description,
        subagentType:
          typeof payload.subagentType === 'string'
            ? payload.subagentType
            : prev?.content.subagentType,
        status,
        result:
          typeof payload.result === 'string' && payload.result.length > 0
            ? payload.result
            : prev?.content.result,
        error:
          typeof payload.error === 'string' && payload.error.length > 0
            ? payload.error
            : prev?.content.error,
        reasoning: nextReasoning,
        children: prev?.content.children ?? [],
        structured:
          payload.structured !== undefined
            ? (payload.structured as SubagentTaskPart['content']['structured'])
            : (prev?.content.structured ?? null),
      },
    };

    if (typeof idx === 'number') {
      this.parts[idx] = next;
    } else {
      this.parts.push(next);
      this.partIndexByTaskId.set(taskId, this.parts.length - 1);
    }
    this.lastPartType = 'subagent_task';
  }

  private applySubagentToolEvent(
    taskId: string,
    payload: TaskProgressPayload,
    status: 'tool_call' | 'tool_result',
  ): void {
    let idx = this.partIndexByTaskId.get(taskId);
    if (typeof idx !== 'number') {
      // 父任务未到达，先占位 running 节点
      const placeholder: SubagentTaskPart = {
        partId: uuidv4(),
        type: 'subagent_task',
        createdAt: Date.now(),
        content: { taskId, status: 'running', children: [] },
      };
      this.parts.push(placeholder);
      idx = this.parts.length - 1;
      this.partIndexByTaskId.set(taskId, idx);
    }
    const part = this.parts[idx] as SubagentTaskPart;
    const children: SubagentToolCall[] = [...(part.content.children ?? [])];
    const toolCallId = payload.toolCallId ?? '';

    if (status === 'tool_call') {
      const args = parseJsonSafe(payload.arguments);
      // ghost 防御：args 为空且尚无 result → 跳过入 children，避免落库脏数据
      if (!hasMeaningfulArgs(args)) return;
      const existIdx = children.findIndex((c) => c.toolCallId === toolCallId);
      const item: SubagentToolCall = {
        id: toolCallId || uuidv4(),
        toolCallId,
        name: payload.toolName ?? '',
        args,
        status: 'running',
      };
      if (existIdx === -1) children.push(item);
      else
        children[existIdx] = { ...children[existIdx], ...item, status: children[existIdx].status };
    } else {
      const success = payload.toolSuccess !== false;
      const result = payload.toolResult;
      const errorMessage =
        typeof payload.toolErrorMessage === 'string' ? payload.toolErrorMessage : undefined;
      const existIdx = children.findIndex((c) => c.toolCallId === toolCallId);
      if (existIdx === -1) {
        children.push({
          id: toolCallId || uuidv4(),
          toolCallId,
          name: payload.toolName ?? '',
          result,
          success,
          errorMessage,
          status: success ? 'done' : 'failed',
        });
      } else {
        children[existIdx] = {
          ...children[existIdx],
          result,
          success,
          errorMessage,
          status: success ? 'done' : 'failed',
        };
      }
    }

    this.parts[idx] = {
      ...part,
      content: { ...part.content, children },
    };
    this.lastPartType = 'subagent_task';
  }

  private applyStateUpdate(stateType: string, data: unknown): void {
    switch (stateType) {
      case 'simple_analysis': {
        const text =
          typeof data === 'string'
            ? data
            : isObjectWithKey(data, 'simpleAnalysis')
              ? data.simpleAnalysis
              : '';
        if (text) this.appendOrMergeReasoning(text);
        break;
      }
      case 'tasks_initial': {
        if (Array.isArray(data)) {
          for (const task of data) {
            const tid = isObjectWithKey(task, 'taskId')
              ? task.taskId
              : isObjectWithKey(task, 'id')
                ? task.id
                : '';
            const desc = isObjectWithKey(task, 'description') ? task.description : undefined;
            const status = isObjectWithKey(task, 'status') ? task.status : 'pending';
            this.upsertSubagentTask({
              taskId: tid,
              description: desc,
              status,
            } as TaskProgressPayload);
          }
        }
        break;
      }
      case 'task_update': {
        this.upsertSubagentTask(data as TaskProgressPayload);
        break;
      }
      case 'report': {
        const content =
          typeof data === 'string' ? data : isObjectWithKey(data, 'report') ? data.report : '';
        const title =
          isObjectWithKey(data, 'title') && data.title.length > 0 ? data.title : '研究报告';
        if (typeof content === 'string' && content.length > 0) {
          this.parts.push({
            partId: uuidv4(),
            type: 'artifact',
            createdAt: Date.now(),
            content: { title, markdown: content },
          });
          this.lastPartType = 'artifact';
        }
        break;
      }
      default:
        // research_target / custom 忽略
        break;
    }
  }
}

// 防止未使用导入警告（ClientAgentEventType type re-export）
export type { ClientAgentEventType };
