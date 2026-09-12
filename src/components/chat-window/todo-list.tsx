'use client';

import { CheckCircleFilled, ClockCircleOutlined, LoadingOutlined } from '@ant-design/icons';

import type { MessagePart } from '@/types';

type TodoPart = Extract<MessagePart, { type: 'todo' }>;
type TodoItem = TodoPart['content']['todos'][number];

/**
 * TodoList —— 时间线内的任务清单快照
 *
 * 数据来自 `todo_update` 事件（write_todos 工具每轮下发的全量清单），
 * 同一条消息内只保留一份 part（latest-wins），故这里只做纯渲染。
 *
 * `streaming=false`（消息已结束/失败/中止）时不再用旋转图标：那种情况下不会
 * 再有新事件到达，继续转圈会误导用户「还在进行」。
 */
const TodoList: React.FC<{ todos: TodoItem[]; streaming?: boolean }> = ({
  todos,
  streaming = false,
}) => {
  if (todos.length === 0) return null;

  const completedCount = todos.filter((t) => t.status === 'completed').length;

  return (
    <div className="min-w-0 rounded-xl border border-gray-100 bg-gray-50/60 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-gray-600">
        <ClockCircleOutlined className="text-teal-500" />
        <span>任务清单</span>
        <span className="text-gray-400">
          {completedCount}/{todos.length}
        </span>
      </div>
      <ul className="flex min-w-0 flex-col gap-1.5">
        {todos.map((todo, index) => (
          <li key={index} className="flex min-w-0 items-start gap-2 text-sm">
            {todo.status === 'completed' && (
              <CheckCircleFilled className="mt-0.5 shrink-0 text-green-500" />
            )}
            {todo.status === 'in_progress' && streaming && (
              <LoadingOutlined className="mt-0.5 shrink-0 text-teal-500" />
            )}
            {todo.status === 'in_progress' && !streaming && (
              // 流已结束但该项未闭合（失败/中止）：静态标记，不再旋转
              <span className="mt-0.5 inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-amber-400" />
            )}
            {todo.status === 'pending' && (
              <span className="mt-0.5 inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-gray-300" />
            )}
            <span
              className={
                todo.status === 'completed'
                  ? 'min-w-0 wrap-break-word text-gray-400 line-through'
                  : 'min-w-0 wrap-break-word text-gray-700'
              }
            >
              {todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default TodoList;
