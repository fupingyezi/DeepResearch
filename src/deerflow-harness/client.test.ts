import { beforeEach, describe, expect, it } from 'vitest';
import { createMiddleware, type AgentMiddleware } from 'langchain';

import { buildConfigKey } from './client';
import {
  registerExtraMiddleware,
  getExtraMiddlewaresSignature,
  resetExtraMiddlewares,
} from './agents/extra-middlewares';
import type { ModelConfig } from './types';

/**
 * buildConfigKey 是 agent 缓存键的唯一来源，此处锁定 extra-middlewares 注册
 * 签名与键的失效契约（注册变化 → 键变化 → 缓存重建）。ensureAgent 内部接线
 * 由组装测试（extra-middlewares.test.ts）与三行字面量覆盖，不 mock 私有方法。
 */

const modelConfig = { modelName: 'test-model' } as ModelConfig;

const baseOpts = {
  memoryEnabled: false,
  memoryMode: 'inject' as const,
  autoTitleEnabled: false,
  threadDataEnabled: false,
  uploadsEnabled: false,
  sandboxEnabled: false,
  summarizationEnabled: false,
  guardrailEnabled: false,
  todoEnabled: false,
  mcpEnabled: true,
  subagentsEnabled: true,
  visionEnabled: false,
  agentName: 'lead',
  userId: null,
};

const keyWith = () =>
  buildConfigKey(
    modelConfig,
    baseOpts,
    'mcp-sig',
    'skill-sig',
    getExtraMiddlewaresSignature('lead'),
  );

describe('buildConfigKey —— extra-middlewares 签名折入', () => {
  beforeEach(() => {
    resetExtraMiddlewares();
  });

  it('lead 注册改变缓存键（其余参量固定）', () => {
    const before = keyWith();
    registerExtraMiddleware(createMiddleware({ name: 'KeyMw' }) as AgentMiddleware, {
      scope: 'lead',
    });
    expect(keyWith()).not.toBe(before);
  });

  it('subagent-only 注册不改变 lead 键（scope 隔离不误伤缓存）', () => {
    const before = keyWith();
    registerExtraMiddleware(createMiddleware({ name: 'SubKeyMw' }) as AgentMiddleware, {
      scope: 'subagent',
    });
    expect(keyWith()).toBe(before);
  });

  it('描述符完全相同的两个不同实例仍改变键（计数器兜底）', () => {
    registerExtraMiddleware(createMiddleware({ name: 'TwinMw' }) as AgentMiddleware);
    const first = keyWith();
    registerExtraMiddleware(createMiddleware({ name: 'TwinMw' }) as AgentMiddleware);
    expect(keyWith()).not.toBe(first);
  });
});
