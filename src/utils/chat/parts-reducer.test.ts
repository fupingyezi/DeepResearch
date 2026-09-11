import { describe, expect, it } from 'vitest';

import { ClientAgentEventType } from '@deerflow-harness/runtime/sse/client-event';
import type { ClientAgentEvent } from '@deerflow-harness/runtime/sse/client-event';
import type { MessagePart } from '@/types';

import { initialPartsState, reducePartsState } from './parts-reducer';

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
