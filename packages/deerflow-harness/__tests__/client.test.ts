import { beforeEach, describe, expect, it } from 'vitest';
import { createMiddleware, type AgentMiddleware } from 'langchain';

import {
  buildConfigKey,
  buildRetrievalQueries,
  collectRecentHumanTexts,
  readRecentHumanTexts,
} from '../client';
import {
  registerExtraMiddleware,
  getExtraMiddlewaresSignature,
  resetExtraMiddlewares,
} from '../agents/extra-middlewares';
import type { ModelConfig } from '../types';

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

describe('buildConfigKey —— skill 签名折入', () => {
  it('仅 skill 签名不同即改变缓存键（L1 注入内容变化 → agent 重建）', () => {
    const extraSig = getExtraMiddlewaresSignature('lead');
    const withSkillSig = (sig: string) =>
      buildConfigKey(modelConfig, baseOpts, 'mcp-sig', sig, extraSig);
    expect(withSkillSig('skill-sig-A')).not.toBe(withSkillSig('skill-sig-B'));
  });
});

describe('collectRecentHumanTexts', () => {
  const human = (content: unknown) => ({ _getType: () => 'human', content });
  const ai = (content: unknown) => ({ _getType: () => 'ai', content });

  it('只取 human，跳过 ai，按时间序（旧→新）返回', () => {
    const messages = [human('第一轮'), ai('回答一'), human('第二轮'), ai('回答二')];
    expect(collectRecentHumanTexts(messages, 5)).toEqual(['第一轮', '第二轮']);
  });

  it('limit 只保留最近 N 条', () => {
    const messages = [human('一'), human('二'), human('三'), human('四')];
    expect(collectRecentHumanTexts(messages, 2)).toEqual(['三', '四']);
  });

  it('多模态 content 只取 text 块', () => {
    const messages = [human([{ type: 'text', text: '看这张图' }, { image_url: 'data:...' }])];
    expect(collectRecentHumanTexts(messages, 1)).toEqual(['看这张图']);
  });

  it('剥离 <uploaded_files> 块（文件名会稀释词面重叠率）', () => {
    const messages = [human('<uploaded_files>report.pdf</uploaded_files>\n帮我总结一下这个')];
    expect(collectRecentHumanTexts(messages, 1)).toEqual(['帮我总结一下这个']);
  });

  it('空 content / 非数组输入不产生条目', () => {
    expect(collectRecentHumanTexts([human('  '), human('')], 5)).toEqual([]);
    expect(collectRecentHumanTexts('not-an-array' as unknown as unknown[], 5)).toEqual([]);
    expect(collectRecentHumanTexts([human('x')], 0)).toEqual([]);
  });
});

describe('buildRetrievalQueries', () => {
  it('词面拼接近 N 轮 + 当前轮（旧→新），语义只取当前轮', () => {
    const { lexicalQuery, semanticQuery } = buildRetrievalQueries('它呢？', [
      '用什么数据库',
      '继续',
    ]);
    expect(lexicalQuery).toBe('用什么数据库\n继续\n它呢？');
    expect(semanticQuery).toBe('它呢？'); // 语义不拼串（拼串会稀释向量语义）
  });

  it('当前轮缺失时语义回落最近一轮（resume 场景），词面不重复计入', () => {
    const { lexicalQuery, semanticQuery } = buildRetrievalQueries(undefined, ['第一轮', '第二轮']);
    expect(semanticQuery).toBe('第二轮');
    expect(lexicalQuery).toBe('第一轮\n第二轮');
  });

  it('历史中与当前轮重复的条目被去重', () => {
    const { lexicalQuery } = buildRetrievalQueries('重发的问题', ['重发的问题']);
    expect(lexicalQuery).toBe('重发的问题');
  });

  it('全空时两个 query 均为空串', () => {
    expect(buildRetrievalQueries(undefined, [])).toEqual({
      lexicalQuery: '',
      semanticQuery: '',
    });
  });
});

describe('readRecentHumanTexts', () => {
  it('从 getTuple 的 checkpoint.channel_values.messages 取 human 文本', async () => {
    const saver = {
      getTuple: async () => ({
        checkpoint: {
          channel_values: {
            messages: [
              { _getType: () => 'human', content: '之前的问题' },
              { _getType: () => 'ai', content: '回答' },
            ],
          },
        },
      }),
    };
    await expect(readRecentHumanTexts(saver as never, 'thread-1', 3)).resolves.toEqual([
      '之前的问题',
    ]);
  });

  it('saver 缺失或没有 getTuple → 空数组（不抛）', async () => {
    await expect(readRecentHumanTexts(undefined, 'thread-1', 3)).resolves.toEqual([]);
    await expect(readRecentHumanTexts({} as never, 'thread-1', 3)).resolves.toEqual([]);
  });

  it('getTuple 抛错 / 无 checkpoint → 空数组（记忆检索失败不影响主流程）', async () => {
    const throwing = {
      getTuple: async () => {
        throw new Error('db down');
      },
    };
    await expect(readRecentHumanTexts(throwing as never, 'thread-1', 3)).resolves.toEqual([]);
    const empty = { getTuple: async () => undefined };
    await expect(readRecentHumanTexts(empty as never, 'thread-1', 3)).resolves.toEqual([]);
  });
});
