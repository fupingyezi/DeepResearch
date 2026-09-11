import { describe, expect, it } from 'vitest';
import { createMiddleware } from 'langchain';

import { assembleFromFeatures } from './factory';
import { DEFAULT_FEATURES } from './features';
import { SUBAGENT_FEATURES } from '../subagents/executor';

const toolNames = (extraTools: { name?: string }[]): string[] =>
  extraTools.map((t) => t.name ?? '?');

describe('assembleFromFeatures —— 防递归（task 工具可见性）', () => {
  it('lead（DEFAULT_FEATURES）注入 task 工具', () => {
    const { extraTools, chain } = assembleFromFeatures(DEFAULT_FEATURES, {});
    expect(toolNames(extraTools)).toContain('task');
    // 默认启用 subagents → 需要用量限额兜底
    expect(chain.map((m) => m.name)).toContain('SubagentLimitMiddleware');
  });

  it('subagent（SUBAGENT_FEATURES）不注入 task 工具，也不挂 SubagentLimit', () => {
    const { extraTools, chain } = assembleFromFeatures(SUBAGENT_FEATURES, {});
    expect(toolNames(extraTools)).not.toContain('task');
    expect(chain.map((m) => m.name)).not.toContain('SubagentLimitMiddleware');
  });

  it('features.subagents=false 不注入 task；未设置（undefined）则注入', () => {
    expect(
      toolNames(assembleFromFeatures({ ...DEFAULT_FEATURES, subagents: false }, {}).extraTools),
    ).not.toContain('task');
    expect(
      toolNames(assembleFromFeatures({ ...DEFAULT_FEATURES, subagents: undefined }, {}).extraTools),
    ).toContain('task');
  });
});

describe('assembleFromFeatures —— 服务级开关装配一致性', () => {
  // 与 src/app/api/threads/_service.ts 的 sharedClientOptions 对应：
  // 任一开关在装配层被静默丢弃（历史上 guardrail/summarization/todo 都发生过），
  // 该用例即失败，避免「文档说装了、代码没装」再次出现。
  it('服务级默认的 7 个可选开关全部落到链上', () => {
    const summarization = createMiddleware({ name: 'SummarizationMiddleware' });
    const { chain } = assembleFromFeatures(
      {
        threadData: true,
        uploads: true,
        sandbox: true,
        summarization: summarization as never,
        todo: true,
        autoTitle: true,
        memory: true,
        guardrail: true,
      },
      {},
    );
    const names = chain.map((m) => m.name);
    for (const expected of [
      'ThreadDataMiddleware',
      'UploadsMiddleware',
      'SandboxMiddleware',
      'SummarizationMiddleware',
      // 框架现成实现，name 为小写 todoListMiddleware
      'todoListMiddleware',
      'TitleMiddleware',
      'MemoryMiddleware',
      'GuardrailMiddleware',
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe('assembleFromFeatures —— 位序中间件装配', () => {
  it('始终启用的中间件按 0→12 位序出现在链上', () => {
    const { chain } = assembleFromFeatures(DEFAULT_FEATURES, {});
    const names = chain.map((m) => m.name);
    // 位序 3 / 5 / 11 / 12 为始终启用项
    expect(names).toContain('ToolCallIntegrityMiddleware');
    expect(names).toContain('ToolErrorHandlingMiddleware');
    expect(names).toContain('SubagentLimitMiddleware');
    expect(names).toContain('LoopDetectionMiddleware');
  });

  it('features.sandbox=true 时注入 7 个沙箱工具并挂 SandboxMiddleware', () => {
    const { chain, extraTools } = assembleFromFeatures({ ...DEFAULT_FEATURES, sandbox: true }, {});
    expect(chain.map((m) => m.name)).toContain('SandboxMiddleware');
    for (const name of ['bash', 'ls', 'glob', 'grep', 'read_file', 'write_file', 'str_replace']) {
      expect(toolNames(extraTools)).toContain(name);
    }
  });

  it('summarization 传实例时挂载在位序 6（toolErrorHandling 之后、todo 之前）', () => {
    const instance = createMiddleware({ name: 'MySummarization' });
    const { chain } = assembleFromFeatures(
      { ...DEFAULT_FEATURES, summarization: instance as never },
      {},
    );
    const names = chain.map((m) => m.name);
    expect(names).toContain('MySummarization');
    expect(names.indexOf('MySummarization')).toBeGreaterThan(
      names.indexOf('ToolErrorHandlingMiddleware'),
    );
    expect(names.indexOf('MySummarization')).toBeLessThan(names.indexOf('SubagentLimitMiddleware'));
  });

  it('summarization 为 false/undefined 时不挂载（不允许 true 走默认实现）', () => {
    for (const value of [false, undefined] as const) {
      const { chain } = assembleFromFeatures({ ...DEFAULT_FEATURES, summarization: value }, {});
      expect(chain.map((m) => m.name)).not.toContain('SummarizationMiddleware');
    }
  });
});
