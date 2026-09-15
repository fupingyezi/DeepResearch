import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMiddleware, type AgentMiddleware } from 'langchain';

import { assembleFromFeatures } from './factory';
import { DEFAULT_FEATURES, type MiddlewareAnchor } from './features';
import {
  registerExtraMiddleware,
  getExtraMiddlewares,
  getExtraMiddlewaresSignature,
  resetExtraMiddlewares,
} from './extra-middlewares';
import { SUBAGENT_FEATURES } from '../subagents/executor';
import { memoryMiddleware, toolErrorHandlingMiddleware } from './middlewares';

function positioned(
  name: string,
  anchor: MiddlewareAnchor,
  side: 'next' | 'prev',
): AgentMiddleware {
  const middleware = createMiddleware({ name }) as AgentMiddleware;
  Object.assign(middleware, side === 'next' ? { _nextAnchor: anchor } : { _prevAnchor: anchor });
  return middleware;
}

const names = (chain: AgentMiddleware[]): string[] => chain.map((m) => m.name ?? '?');
const indexOf = (chain: AgentMiddleware[], name: string): number => names(chain).indexOf(name);

describe('extra-middlewares 注册表', () => {
  beforeEach(() => {
    resetExtraMiddlewares();
  });
  afterEach(() => {
    resetExtraMiddlewares();
  });

  it('默认 scope=both：lead 与 subagent 都能读到', () => {
    const mw = createMiddleware({ name: 'BothMw' }) as AgentMiddleware;
    registerExtraMiddleware(mw);

    expect(getExtraMiddlewares('lead')).toEqual([mw]);
    expect(getExtraMiddlewares('subagent')).toEqual([mw]);
  });

  it('scope 过滤：lead-only 不进 subagent，subagent-only 不进 lead', () => {
    const leadOnly = createMiddleware({ name: 'LeadOnly' }) as AgentMiddleware;
    const subOnly = createMiddleware({ name: 'SubOnly' }) as AgentMiddleware;
    registerExtraMiddleware(leadOnly, { scope: 'lead' });
    registerExtraMiddleware(subOnly, { scope: 'subagent' });

    expect(getExtraMiddlewares('lead')).toEqual([leadOnly]);
    expect(getExtraMiddlewares('subagent')).toEqual([subOnly]);
  });

  it('读取返回拷贝：改数组不泄漏进注册表，实例保持同一', () => {
    const mw = createMiddleware({ name: 'CopyMw' }) as AgentMiddleware;
    registerExtraMiddleware(mw);

    const arr = getExtraMiddlewares('lead');
    arr.push(createMiddleware({ name: 'Intruder' }) as AgentMiddleware);
    expect(getExtraMiddlewares('lead')).toEqual([mw]);
    expect(getExtraMiddlewares('lead')[0]).toBe(mw);
  });

  it('注册序保持', () => {
    const a = createMiddleware({ name: 'First' }) as AgentMiddleware;
    const b = createMiddleware({ name: 'Second' }) as AgentMiddleware;
    registerExtraMiddleware(a);
    registerExtraMiddleware(b);

    expect(names(getExtraMiddlewares('lead'))).toEqual(['First', 'Second']);
  });

  it('同实例重复注册为 no-op 且只告警一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mw = createMiddleware({ name: 'DupMw' }) as AgentMiddleware;
      registerExtraMiddleware(mw);
      registerExtraMiddleware(mw);
      registerExtraMiddleware(mw);

      expect(getExtraMiddlewares('lead')).toEqual([mw]);
      const dupWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes('DupMw'));
      expect(dupWarnings).toHaveLength(2); // 第二、三次各一条，不递增刷屏
    } finally {
      warn.mockRestore();
    }
  });

  it('签名跨读取确定', () => {
    const mw = createMiddleware({ name: 'SigMw' }) as AgentMiddleware;
    registerExtraMiddleware(mw);

    expect(getExtraMiddlewaresSignature('lead')).toBe(getExtraMiddlewaresSignature('lead'));
  });

  it('scope 隔离：lead 注册改变 lead 签名、subagent 签名不动', () => {
    const before = getExtraMiddlewaresSignature('subagent');
    registerExtraMiddleware(createMiddleware({ name: 'LeadSigMw' }) as AgentMiddleware, {
      scope: 'lead',
    });

    expect(getExtraMiddlewaresSignature('lead')).not.toBe(getExtraMiddlewaresSignature('subagent'));
    expect(getExtraMiddlewaresSignature('subagent')).toBe(before);
  });

  it('both 注册同时改变两个 scope 的签名', () => {
    const leadBefore = getExtraMiddlewaresSignature('lead');
    const subBefore = getExtraMiddlewaresSignature('subagent');
    registerExtraMiddleware(createMiddleware({ name: 'BothSigMw' }) as AgentMiddleware);

    expect(getExtraMiddlewaresSignature('lead')).not.toBe(leadBefore);
    expect(getExtraMiddlewaresSignature('subagent')).not.toBe(subBefore);
  });

  it('同名实例有无锚点 → 签名不同（描述符参与编码）', () => {
    resetExtraMiddlewares();
    registerExtraMiddleware(createMiddleware({ name: 'SameName' }) as AgentMiddleware);
    const plainSig = getExtraMiddlewaresSignature('lead');

    resetExtraMiddlewares();
    registerExtraMiddleware(positioned('SameName', toolErrorHandlingMiddleware, 'next'));
    const anchoredSig = getExtraMiddlewaresSignature('lead');

    expect(anchoredSig).not.toBe(plainSig);
  });

  it('reset 回到空注册表签名', () => {
    const emptySig = getExtraMiddlewaresSignature('lead');
    registerExtraMiddleware(createMiddleware({ name: 'TempMw' }) as AgentMiddleware);
    expect(getExtraMiddlewaresSignature('lead')).not.toBe(emptySig);

    resetExtraMiddlewares();
    expect(getExtraMiddlewaresSignature('lead')).toBe(emptySig);
    expect(getExtraMiddlewares('lead')).toEqual([]);
  });

  it('lead 组装：注册表内容经 getExtraMiddlewares 进入装配链并按锚点落位', () => {
    registerExtraMiddleware(positioned('CustomLeadScoped', toolErrorHandlingMiddleware, 'next'), {
      scope: 'lead',
    });

    const { chain } = assembleFromFeatures(DEFAULT_FEATURES, {
      extraMiddlewares: getExtraMiddlewares('lead'),
    });

    const teh = indexOf(chain, 'ToolErrorHandlingMiddleware');
    expect(teh).toBeGreaterThanOrEqual(0);
    expect(indexOf(chain, 'CustomLeadScoped')).toBe(teh + 1);
  });

  it('subagent 组装：subagent 条目在链上、lead 条目不在', () => {
    registerExtraMiddleware(createMiddleware({ name: 'SubScoped' }) as AgentMiddleware, {
      scope: 'subagent',
    });
    registerExtraMiddleware(createMiddleware({ name: 'LeadScoped' }) as AgentMiddleware, {
      scope: 'lead',
    });

    const { chain } = assembleFromFeatures(SUBAGENT_FEATURES, {
      extraMiddlewares: getExtraMiddlewares('subagent'),
    });

    expect(indexOf(chain, 'SubScoped')).toBeGreaterThanOrEqual(0);
    expect(indexOf(chain, 'LeadScoped')).toBe(-1);
  });

  it('both + feature 门控锚点：两链都不丢，未命中的链落尾并告警一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // SUBAGENT_FEATURES/DEFAULT_FEATURES 均未开 memory → 锚 MemoryMiddleware
      // 在两条链上都未命中：落尾 + 告警（模块级去重，整个进程只报一次）
      registerExtraMiddleware(positioned('CustomBothScoped', memoryMiddleware, 'prev'));

      const lead = assembleFromFeatures(DEFAULT_FEATURES, {
        extraMiddlewares: getExtraMiddlewares('lead'),
      }).chain;
      const sub = assembleFromFeatures(SUBAGENT_FEATURES, {
        extraMiddlewares: getExtraMiddlewares('subagent'),
      }).chain;

      expect(indexOf(lead, 'CustomBothScoped')).toBe(lead.length - 1);
      expect(indexOf(sub, 'CustomBothScoped')).toBe(sub.length - 1);
      const missWarnings = warn.mock.calls.filter(([msg]) =>
        String(msg).includes('CustomBothScoped'),
      );
      expect(missWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
