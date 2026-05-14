/**
 * toClientAgentEvent
 *
 * event AgentEvent → ClientAgentEvent 的边界映射纯函数。
 *
 * 映射规则：
 * - LIFECYCLE{stage:"start"} → START
 * - LIFECYCLE{stage:"done"}  → END
 * - LLM_STREAM               → STREAM_CHUNK
 * - TOOL_CALL_START          → TOOL_CALL
 * - TOOL_CALL_RESULT         → TOOL_RESULT
 * - STATE_UPDATE             → STATE_UPDATE（透传）
 * - TASK_PROGRESS            → TASK_PROGRESS（透传）
 * - HUMAN_INTERRUPT          → HUMAN_INTERRUPT（透传）
 * - ERROR                    → ERROR（透传）
 * - 其余（LLM_COMPLETE / HUMAN_RESUME / NODE_* / SUB_AGENT_* / HARNESS_*）
 *   → HEARTBEAT（仅保留 timestamp + agentId，不携带业务 payload）
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
      const stage = event.payload.stage;
      if (stage === 'start') {
        // 透传 metadata.sessionId（若有）
        const sessionId = (event.metadata?.sessionId as string | undefined) ?? undefined;
        return createClientAgentEvent(
          ClientAgentEventType.START,
          agentId,
          sessionId ? { sessionId } : {},
        );
      }
      return createClientAgentEvent(ClientAgentEventType.END, agentId, {} as Record<string, never>);
    }

    case AgentEventType.LLM_STREAM: {
      return createClientAgentEvent(ClientAgentEventType.STREAM_CHUNK, agentId, {
        text: event.payload.text,
        reasoning: event.payload.reasoning,
      });
    }

    case AgentEventType.TOOL_CALL_START: {
      return createClientAgentEvent(ClientAgentEventType.TOOL_CALL, agentId, {
        toolCallId: event.payload.toolCallId,
        toolName: event.payload.toolName,
        arguments: event.payload.arguments,
      });
    }

    case AgentEventType.TOOL_CALL_RESULT: {
      return createClientAgentEvent(ClientAgentEventType.TOOL_RESULT, agentId, {
        toolCallId: event.payload.toolCallId,
        toolName: event.payload.toolName,
        result: event.payload.result,
        success: event.payload.success,
        errorMessage: event.payload.errorMessage,
      });
    }

    case AgentEventType.STATE_UPDATE: {
      return createClientAgentEvent(ClientAgentEventType.STATE_UPDATE, agentId, {
        stateType: event.payload.stateType,
        data: event.payload.data,
      });
    }

    case AgentEventType.TASK_PROGRESS: {
      return createClientAgentEvent(ClientAgentEventType.TASK_PROGRESS, agentId, {
        ...event.payload,
      });
    }

    case AgentEventType.HUMAN_INTERRUPT: {
      return createClientAgentEvent(ClientAgentEventType.HUMAN_INTERRUPT, agentId, {
        question: event.payload.question,
        details: event.payload.details,
      });
    }

    case AgentEventType.ERROR: {
      return createClientAgentEvent(ClientAgentEventType.ERROR, agentId, {
        errorCode: event.payload.errorCode,
        errorMessage: event.payload.errorMessage,
        recoverable: event.payload.recoverable,
      });
    }

    // 全部降级为 HEARTBEAT
    case AgentEventType.LLM_COMPLETE:
    case AgentEventType.HUMAN_RESUME:
    case AgentEventType.NODE_ENTER:
    case AgentEventType.NODE_EXIT:
    case AgentEventType.SUB_AGENT_DISPATCH:
    case AgentEventType.HARNESS_LIFECYCLE:
    default:
      return createClientAgentEvent(
        ClientAgentEventType.HEARTBEAT,
        agentId,
        {} as Record<string, never>,
      );
  }
}
