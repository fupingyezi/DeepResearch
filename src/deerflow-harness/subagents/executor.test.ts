import { describe, expect, it } from 'vitest';

import { buildSubagentStreamConfig, SUBAGENT_FEATURES } from './executor';

describe('SUBAGENT_FEATURES —— 子 agent 能力边界', () => {
  it('硬性关闭 subagents（防递归），其余继承库级默认', () => {
    expect(SUBAGENT_FEATURES.subagents).toBe(false);
    expect(SUBAGENT_FEATURES.sandbox).toBe(false);
    expect(SUBAGENT_FEATURES.memory).toBe(false);
  });
});

describe('buildSubagentStreamConfig —— 子图 configurable', () => {
  it('有 threadId 时透传 thread_id（供工具层解析同一沙箱/线程上下文）', () => {
    expect(buildSubagentStreamConfig('thread-1')).toEqual({ thread_id: 'thread-1' });
  });

  it('无 threadId 时返回 undefined（不设 configurable）', () => {
    expect(buildSubagentStreamConfig(undefined)).toBeUndefined();
  });

  it('不下发 checkpoint_ns', () => {
    // 顶层图（非嵌套）的 ns 会被 LangGraph 强制置空，下发无意义，
    // 详见 buildSubagentStreamConfig 的注释与 subagent-checkpoint-quirks.integration.test.ts
    const config = buildSubagentStreamConfig('thread-1');
    expect(config).not.toHaveProperty('checkpoint_ns');
  });
});
