import { describe, expect, it } from 'vitest';

import { ClientAgentEventType } from '@deerflow-harness/runtime/sse/client-event';
import type { ClientAgentEvent } from '@deerflow-harness/runtime/sse/client-event';

import { AssistantPartsCollector } from './assistant-parts-collector';

/**
 * 取消标记的落库形态：这轮被取消时，正文/总结之后补一行 cancelled part，
 * 且必须排在 finalize 补出来的 task_summary / artifact **之后**（阅读顺序：
 * 正文 → 总结 → 本轮到哪儿结束）。
 */

const chunk = (text: string): ClientAgentEvent =>
  ({
    eventType: ClientAgentEventType.STREAM_CHUNK,
    timestamp: Date.now(),
    agentId: 'lead',
    payload: { text },
  }) as ClientAgentEvent;

describe('AssistantPartsCollector.finalize —— 取消标记', () => {
  it('标记追加在最末（排在 task_summary 之后）', () => {
    const collector = new AssistantPartsCollector();
    collector.onEvent(chunk('正文内容'));
    collector.onEvent({
      eventType: ClientAgentEventType.TASK_PROGRESS,
      timestamp: Date.now(),
      agentId: 'lead',
      payload: {
        taskId: 't-1',
        status: 'completed',
        description: '子任务',
        result: '结论',
        subagentType: 'general-purpose',
      },
    } as ClientAgentEvent);

    const { parts } = collector.finalize('兜底标题', '用户已取消');
    const types = parts.map((p) => p.type);
    expect(types.at(-1)).toBe('cancelled');
    expect(types).toContain('task_summary');
    expect(types.indexOf('task_summary')).toBeLessThan(types.length - 1);
  });

  it('没有取消文案时不补标记', () => {
    const collector = new AssistantPartsCollector();
    collector.onEvent(chunk('正文内容'));
    const { parts } = collector.finalize('标题', null);
    expect(parts.some((p) => p.type === 'cancelled')).toBe(false);
  });

  it('parts 为空时不落空消息（标记也不加）', () => {
    const collector = new AssistantPartsCollector();
    const { parts } = collector.finalize('标题', '用户已取消');
    expect(parts).toHaveLength(0);
  });
});
