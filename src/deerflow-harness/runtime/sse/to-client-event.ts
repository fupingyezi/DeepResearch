/**
 * toClientAgentEvent
 *
 * AgentEvent → ClientAgentEvent 的边界映射纯函数
 *
 * - LIFECYCLE{stage:"start"} → START
 * - LIFECYCLE{stage:"done"}  → END
 * - 其他事件类型             → 同名客户端事件（payload 透传）
 *
 * 若新增 AgentEventType 但未在此处加 case，TypeScript 的 exhaustive 检查
 * （`never` 兜底）会在编译期报错。
 */

import { AgentEventType, type AgentEvent } from '../../types/agent-event';
import {
  ClientAgentEventType,
  createClientAgentEvent,
  type ClientAgentEvent,
} from './client-event';

export function toClientAgentEvent(event: AgentEvent): ClientAgentEvent {
  const { agentId } = event;

  switch (event.eventType) {
    case AgentEventType.LIFECYCLE: {
      if (event.payload.stage === 'start') {
        const sessionId = (event.metadata?.sessionId as string | undefined) ?? undefined;
        return createClientAgentEvent(
          ClientAgentEventType.START,
          agentId,
          sessionId ? { sessionId } : {},
        );
      }
      return createClientAgentEvent(ClientAgentEventType.END, agentId, {} as Record<string, never>);
    }

    case AgentEventType.LLM_STREAM:
      return createClientAgentEvent(ClientAgentEventType.STREAM_CHUNK, agentId, {
        text: event.payload.text,
        reasoning: event.payload.reasoning,
      });

    case AgentEventType.LLM_COMPLETE:
      return createClientAgentEvent(ClientAgentEventType.LLM_COMPLETE, agentId, {
        fullText: event.payload.fullText,
        usage: event.payload.usage,
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

    case AgentEventType.STATE_UPDATE:
      return createClientAgentEvent(ClientAgentEventType.STATE_UPDATE, agentId, {
        stateType: event.payload.stateType,
        data: event.payload.data,
      });

    case AgentEventType.TASK_PROGRESS:
      return createClientAgentEvent(ClientAgentEventType.TASK_PROGRESS, agentId, {
        ...event.payload,
      });

    case AgentEventType.HUMAN_INTERRUPT:
      return createClientAgentEvent(ClientAgentEventType.HUMAN_INTERRUPT, agentId, {
        question: event.payload.question,
        details: event.payload.details,
      });

    case AgentEventType.HUMAN_RESUME:
      return createClientAgentEvent(ClientAgentEventType.HUMAN_RESUME, agentId, {
        decision: event.payload.decision,
        resumeTarget: event.payload.resumeTarget,
      });

    case AgentEventType.NODE_ENTER:
      return createClientAgentEvent(ClientAgentEventType.NODE_ENTER, agentId, {
        nodeName: event.payload.nodeName,
        inputSummary: event.payload.inputSummary,
      });

    case AgentEventType.NODE_EXIT:
      return createClientAgentEvent(ClientAgentEventType.NODE_EXIT, agentId, {
        nodeName: event.payload.nodeName,
        outputDelta: event.payload.outputDelta,
      });

    case AgentEventType.SUB_AGENT_DISPATCH:
      return createClientAgentEvent(ClientAgentEventType.SUB_AGENT_DISPATCH, agentId, {
        subAgentName: event.payload.subAgentName,
        task: event.payload.task,
        status: event.payload.status,
        result: event.payload.result,
        errorMessage: event.payload.errorMessage,
        durationMs: event.payload.durationMs,
      });

    case AgentEventType.HARNESS_LIFECYCLE:
      return createClientAgentEvent(ClientAgentEventType.HARNESS_LIFECYCLE, agentId, {
        harnessId: event.payload.harnessId,
        phase: event.payload.phase,
        status: event.payload.status,
        depth: event.payload.depth,
        timestamp: event.payload.timestamp,
        errorMessage: event.payload.errorMessage,
      });

    case AgentEventType.TASK_STARTED:
      return createClientAgentEvent(ClientAgentEventType.TASK_STARTED, agentId, {
        taskId: event.payload.taskId,
        description: event.payload.description,
        subagentType: event.payload.subagentType,
      });

    case AgentEventType.TASK_RUNNING:
      return createClientAgentEvent(ClientAgentEventType.TASK_RUNNING, agentId, {
        taskId: event.payload.taskId,
        message: event.payload.message,
        messageIndex: event.payload.messageIndex,
        totalMessages: event.payload.totalMessages,
      });

    case AgentEventType.TASK_COMPLETED:
      return createClientAgentEvent(ClientAgentEventType.TASK_COMPLETED, agentId, {
        taskId: event.payload.taskId,
        result: event.payload.result,
      });

    case AgentEventType.TASK_FAILED:
      return createClientAgentEvent(ClientAgentEventType.TASK_FAILED, agentId, {
        taskId: event.payload.taskId,
        error: event.payload.error,
      });

    case AgentEventType.TASK_CANCELLED:
      return createClientAgentEvent(ClientAgentEventType.TASK_CANCELLED, agentId, {
        taskId: event.payload.taskId,
        error: event.payload.error,
      });

    case AgentEventType.TASK_TIMED_OUT:
      return createClientAgentEvent(ClientAgentEventType.TASK_TIMED_OUT, agentId, {
        taskId: event.payload.taskId,
        error: event.payload.error,
      });

    case AgentEventType.ERROR:
      return createClientAgentEvent(ClientAgentEventType.ERROR, agentId, {
        errorCode: event.payload.errorCode,
        errorMessage: event.payload.errorMessage,
        recoverable: event.payload.recoverable,
      });

    default: {
      // exhaustive 检查：若 AgentEventType 新增成员但未在此 switch 处理，
      const _exhaustive: never = event;
      throw new Error(
        `[toClientAgentEvent] unhandled event type: ${(_exhaustive as AgentEvent).eventType}`,
      );
    }
  }
}
