import { describe, expect, it } from 'vitest';

import { ClientAgentEventType } from '@deerflow-harness/runtime/sse/client-event';
import type { ClientAgentEvent } from '@deerflow-harness/runtime/sse/client-event';
import type { MessagePart } from '@/types';

import {
  appendCancelledPart,
  finalizePartsState,
  initialPartsState,
  reducePartsState,
} from './parts-reducer';

type TodoStatus = 'pending' | 'in_progress' | 'completed';

function todoEvent(todos: Array<{ content: string; status: TodoStatus }>): ClientAgentEvent {
  return {
    eventType: ClientAgentEventType.TODO_UPDATE,
    timestamp: Date.now(),
    agentId: 'lead',
    payload: { todos },
  } as ClientAgentEvent;
}

function chunkEvent(text: string): ClientAgentEvent {
  return {
    eventType: ClientAgentEventType.STREAM_CHUNK,
    timestamp: Date.now(),
    agentId: 'lead',
    payload: { text },
  } as ClientAgentEvent;
}

const todoParts = (parts: readonly MessagePart[]) => parts.filter((p) => p.type === 'todo');

/** 取最后一条取消标记的文案（顺带做类型收窄，避免 union content 直接取属性报错）。 */
function cancelledTextOf(parts: readonly MessagePart[]): string | null {
  const last = parts.at(-1);
  if (!last || last.type !== 'cancelled') return null;
  return last.content.text;
}

describe('reducePartsState —— TODO_UPDATE', () => {
  it('首次事件创建一个 todo part', () => {
    const state = reducePartsState(
      initialPartsState,
      todoEvent([{ content: '调研 A', status: 'pending' }]),
    );
    const todos = todoParts(state.parts);
    expect(todos).toHaveLength(1);
    expect(todos[0].content.todos).toEqual([{ content: '调研 A', status: 'pending' }]);
  });

  it('后续事件 latest-wins 覆盖同一条 part，不堆叠快照', () => {
    let state = reducePartsState(
      initialPartsState,
      todoEvent([{ content: 'A', status: 'pending' }]),
    );
    state = reducePartsState(
      state,
      todoEvent([
        { content: 'A', status: 'completed' },
        { content: 'B', status: 'in_progress' },
      ]),
    );

    const todos = todoParts(state.parts);
    expect(todos).toHaveLength(1);
    expect(todos[0].content.todos).toEqual([
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
    ]);
  });

  it('覆盖时 partId 保持不变（React key 稳定）', () => {
    const first = reducePartsState(
      initialPartsState,
      todoEvent([{ content: 'A', status: 'pending' }]),
    );
    const second = reducePartsState(first, todoEvent([{ content: 'A', status: 'completed' }]));
    expect(todoParts(second.parts)[0].partId).toBe(todoParts(first.parts)[0].partId);
  });

  it('与 text part 交错时，todo part 位置不变（原地更新）', () => {
    let state = reducePartsState(initialPartsState, chunkEvent('先说话'));
    state = reducePartsState(state, todoEvent([{ content: 'A', status: 'pending' }]));
    state = reducePartsState(state, chunkEvent('再说话'));
    state = reducePartsState(state, todoEvent([{ content: 'A', status: 'completed' }]));

    const types = state.parts.map((p) => p.type);
    expect(types).toEqual(['text', 'todo', 'text']);
  });

  it('事件中的 todos 被深拷贝，后续外部修改不影响已聚合状态', () => {
    const source = [{ content: 'A', status: 'pending' as TodoStatus }];
    const state = reducePartsState(initialPartsState, todoEvent(source));
    source[0].content = '被外部改写';
    expect(todoParts(state.parts)[0].content.todos[0].content).toBe('A');
  });

  it('空清单事件仍创建/覆盖 part（渲染层自行跳过空清单）', () => {
    const state = reducePartsState(initialPartsState, todoEvent([]));
    expect(todoParts(state.parts)).toHaveLength(1);
    expect(todoParts(state.parts)[0].content.todos).toEqual([]);
  });
});

describe('finalizePartsState —— 收尾闭合未完成的 todo', () => {
  it('正常结束时把残留的 in_progress 标为 completed', () => {
    // 复现真实场景：模型最后一次 write_todos 把最后一项置为 in_progress，
    // 随后直接产出最终回答结束循环，没有机会再发一次 write_todos。
    let state = reducePartsState(
      initialPartsState,
      todoEvent([
        { content: '调研', status: 'completed' },
        { content: '综合撰写文章', status: 'in_progress' },
      ]),
    );
    state = reducePartsState(state, { ...chunkEvent('报告正文'), eventType: 'end' } as never);

    const { parts } = finalizePartsState(state);
    const todos = parts.find((p) => p.type === 'todo')?.content.todos ?? [];
    expect(todos.map((t) => t.status)).toEqual(['completed', 'completed']);
  });

  it('中途失败（收到 ERROR）时不收尾，保留真实状态', () => {
    let state = reducePartsState(
      initialPartsState,
      todoEvent([
        { content: '调研', status: 'completed' },
        { content: '综合撰写文章', status: 'in_progress' },
      ]),
    );
    state = reducePartsState(state, {
      eventType: ClientAgentEventType.ERROR,
      timestamp: Date.now(),
      agentId: 'lead',
      payload: { errorCode: 'E', errorMessage: 'boom', recoverable: false },
    } as unknown as ClientAgentEvent);

    const { parts } = finalizePartsState(state);
    const todos = parts.find((p) => p.type === 'todo')?.content.todos ?? [];
    expect(todos.map((t) => t.status)).toEqual(['completed', 'in_progress']);
  });

  it('无 todo part 或无 in_progress 项时不改变 parts 引用', () => {
    const withoutTodo = finalizePartsState(initialPartsState);
    expect(withoutTodo.parts).toEqual([]);

    const allDone = reducePartsState(
      initialPartsState,
      todoEvent([{ content: 'A', status: 'completed' }]),
    );
    const before = allDone.parts[0];
    const { parts } = finalizePartsState(allDone);
    expect(parts.find((p) => p.type === 'todo')).toBe(before);
  });

  it('pending 项不被收尾（模型明确标记为未开始）', () => {
    const state = reducePartsState(
      initialPartsState,
      todoEvent([
        { content: 'A', status: 'in_progress' },
        { content: 'B', status: 'pending' },
      ]),
    );
    const { parts } = finalizePartsState(state);
    const todos = parts.find((p) => p.type === 'todo')?.content.todos ?? [];
    expect(todos.map((t) => t.status)).toEqual(['completed', 'pending']);
  });
});

describe('appendCancelledPart —— 用户取消标记', () => {
  it('追加到末尾且独立成 part（不与正文合并）', () => {
    const withText = reducePartsState(initialPartsState, chunkEvent('已经产出的正文'));
    const state = appendCancelledPart(withText, '用户已取消');

    expect(state.parts.map((p) => p.type)).toEqual(['text', 'cancelled']);
    expect(cancelledTextOf(state.parts)).toBe('用户已取消');
    expect(state.lastPartType).toBe('cancelled');
  });

  it('finalize 后标记仍在（不被 task_summary / artifact 抽取吞掉）', () => {
    const withText = reducePartsState(initialPartsState, chunkEvent('# 报告\n\n正文'));
    const state = appendCancelledPart(withText, '用户已取消');
    const { parts } = finalizePartsState(state);

    expect(parts.at(-1)?.type).toBe('cancelled');
    expect(cancelledTextOf(parts)).toBe('用户已取消');
  });

  it('空 parts 也能加标记（前端取消早于首个 token 时不再停在转圈态）', () => {
    const state = appendCancelledPart(initialPartsState, '用户已取消');
    expect(state.parts).toHaveLength(1);
    expect(state.parts[0].type).toBe('cancelled');
  });
});
