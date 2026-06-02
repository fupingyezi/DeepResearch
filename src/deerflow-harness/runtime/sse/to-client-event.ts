/**
 * toClientAgentEvent
 *
 * AgentEvent → ClientAgentEvent 的边界映射纯函数（白名单过滤 + task_* 折叠）。
 *
 * 策略：
 * - LIFECYCLE{stage:'start'} → START；LIFECYCLE{stage:'done'} → END
 * - LLM_STREAM → STREAM_CHUNK
 * - TOOL_CALL_START → TOOL_CALL；TOOL_CALL_RESULT → TOOL_RESULT
 * - HUMAN_INTERRUPT / ERROR → 同名透传
 * - TASK_STARTED|RUNNING|COMPLETED|FAILED|CANCELLED|TIMED_OUT
 *     → 全部折叠为 TASK_PROGRESS（status 字段区分）
 * - LLM_COMPLETE / HUMAN_RESUME / NODE_ENTER / NODE_EXIT /
 *   SUB_AGENT_DISPATCH / HARNESS_LIFECYCLE
 *     → 内部观测事件，前端不需要，返回 `null`（caller 跳过 yield）
 *
 * 返回 `null` 表示该事件应在边界 drop，不写入 SSE channel。
 */

import { AgentEventType, type AgentEvent } from '../../types/agent-event';
import {
  ClientAgentEventType,
  createClientAgentEvent,
  type ClientAgentEvent,
  type TaskProgressPayload,
} from './client-event';

const DEBUG = process.env.NODE_ENV !== 'production';

export function toClientAgentEvent(event: AgentEvent): ClientAgentEvent | null {
  const { agentId } = event;

  switch (event.eventType) {
    case AgentEventType.LIFECYCLE: {
      // LIFECYCLE{stage:'start'} 在边界 drop：对外的权威 START 由路由层
      // （/api/v3/chat 的 wrapWithPersistence）统一下发。
      if (event.payload.stage === 'start') {
        return null;
      }
      return createClientAgentEvent(ClientAgentEventType.END, agentId, {} as Record<string, never>);
    }

    case AgentEventType.LLM_STREAM:
      return createClientAgentEvent(ClientAgentEventType.STREAM_CHUNK, agentId, {
        text: event.payload.text,
        reasoning: event.payload.reasoning,
      });

    case AgentEventType.TOOL_CALL_START:
      return createClientAgentEvent(ClientAgentEventType.TOOL_CALL, agentId, {
        toolCallId: event.payload.toolCallId,
        toolName: event.payload.toolName,
        arguments: event.payload.arguments,
      });

    case AgentEventType.TOOL_CALL_RESULT:
      return createClientAgentEvent(ClientAgentEventType.TOOL_RESULT, agentId, {
        toolCallId: event.payload.toolCallId,
        toolName: event.payload.toolName,
        result: event.payload.result,
        success: event.payload.success,
        errorMessage: event.payload.errorMessage,
      });

    case AgentEventType.HUMAN_INTERRUPT:
      return createClientAgentEvent(ClientAgentEventType.HUMAN_INTERRUPT, agentId, {
        question: event.payload.question,
        details: event.payload.details,
      });

    // 折叠所有 task_* 内部事件为 TASK_PROGRESS
    case AgentEventType.TASK_PROGRESS: {
      const p = event.payload as TaskProgressPayload;
      return createClientAgentEvent(ClientAgentEventType.TASK_PROGRESS, agentId, p);
    }

    case AgentEventType.TASK_STARTED:
      return createClientAgentEvent(ClientAgentEventType.TASK_PROGRESS, agentId, {
        taskId: event.payload.taskId,
        status: 'started',
        description: event.payload.description,
        subagentType: event.payload.subagentType,
      });

    case AgentEventType.TASK_RUNNING:
      return createClientAgentEvent(ClientAgentEventType.TASK_PROGRESS, agentId, {
        taskId: event.payload.taskId,
        status: 'running',
        message: event.payload.message,
        messageIndex: event.payload.messageIndex,
        totalMessages: event.payload.totalMessages,
        reasoning: event.payload.reasoning,
      });

    case AgentEventType.TASK_COMPLETED:
      return createClientAgentEvent(ClientAgentEventType.TASK_PROGRESS, agentId, {
        taskId: event.payload.taskId,
        status: 'completed',
        result: event.payload.result,
        structured: (event.payload as { structured?: unknown }).structured ?? null,
      });

    case AgentEventType.TASK_FAILED:
      return createClientAgentEvent(ClientAgentEventType.TASK_PROGRESS, agentId, {
        taskId: event.payload.taskId,
        status: 'failed',
        error: event.payload.error,
      });

    case AgentEventType.TASK_CANCELLED:
      return createClientAgentEvent(ClientAgentEventType.TASK_PROGRESS, agentId, {
        taskId: event.payload.taskId,
        status: 'cancelled',
        error: event.payload.error,
      });

    case AgentEventType.TASK_TIMED_OUT:
      return createClientAgentEvent(ClientAgentEventType.TASK_PROGRESS, agentId, {
        taskId: event.payload.taskId,
        status: 'timed_out',
        error: event.payload.error,
      });

    case AgentEventType.ERROR:
      return createClientAgentEvent(ClientAgentEventType.ERROR, agentId, {
        errorCode: event.payload.errorCode,
        errorMessage: event.payload.errorMessage,
        recoverable: event.payload.recoverable,
      });

    // 内部观测事件 → drop
    case AgentEventType.LLM_COMPLETE:
    case AgentEventType.HUMAN_RESUME:
    case AgentEventType.NODE_ENTER:
    case AgentEventType.NODE_EXIT:
    case AgentEventType.SUB_AGENT_DISPATCH:
    case AgentEventType.HARNESS_LIFECYCLE: {
      if (DEBUG) console.debug('[event-dropped]', event.eventType);
      return null;
    }

    default: {
      // exhaustive 检查：若 AgentEventType 新增成员但未在此 switch 处理
      const _exhaustive: never = event;
      if (DEBUG) {
        console.warn(
          `[toClientAgentEvent] unhandled event type, dropped:`,
          (_exhaustive as AgentEvent).eventType,
        );
      }
      return null;
    }
  }
}
