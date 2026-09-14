import { describe, expect, it, vi } from 'vitest';
import { createMiddleware, type AgentMiddleware } from 'langchain';

import { assembleFromFeatures } from './factory';
import { DEFAULT_FEATURES, Next, Prev, type MiddlewareAnchor } from './features';
import {
  loopDetectionMiddleware,
  memoryMiddleware,
  toolErrorHandlingMiddleware,
} from './middlewares';

/**
 * 造一个带锚点的自定义中间件。
 *
 * 注意 `createMiddleware()` 只保留已知字段（未知字段会被剥离），因此锚点
 * 必须在实例创建后附加 —— 这正是装配器要同时支持两种读取路径的原因。
 */
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

describe('assembleFromFeatures —— @Next/@Prev 锚点插入', () => {
  it('@Prev(anchor) 插到锚点实例之前（锚点为内置中间件实例）', () => {
    const custom = positioned('CustomBeforeLoop', loopDetectionMiddleware, 'prev');
    const { chain } = assembleFromFeatures(DEFAULT_FEATURES, { extraMiddlewares: [custom] });

    const customIndex = indexOf(chain, 'CustomBeforeLoop');
    expect(customIndex).toBeGreaterThanOrEqual(0);
    expect(customIndex).toBe(indexOf(chain, 'LoopDetectionMiddleware') - 1);
  });

  it('@Next(anchor) 插到锚点实例之后', () => {
    const custom = positioned('CustomAfterMemory', memoryMiddleware, 'next');
    const { chain } = assembleFromFeatures(
      { ...DEFAULT_FEATURES, memory: true },
      { extraMiddlewares: [custom] },
    );

    const memoryIndex = indexOf(chain, 'MemoryMiddleware');
    expect(memoryIndex).toBeGreaterThanOrEqual(0);
    expect(indexOf(chain, 'CustomAfterMemory')).toBe(memoryIndex + 1);
  });

  it('锚点写在构造函数（@Next/@Prev 装饰类）上同样生效', () => {
    // 装饰器把锚点写到类上，createMiddleware 的实例不携带该字段 —— 走静态字段回退路径
    const Decorated = class DecoratedMiddleware {};
    Prev(toolErrorHandlingMiddleware)(Decorated as never);
    const custom = createMiddleware({ name: 'ClassDecorated' }) as AgentMiddleware;
    // 让实例的 constructor 指向被装饰的类
    Object.defineProperty(custom, 'constructor', { value: Decorated });

    const { chain } = assembleFromFeatures(DEFAULT_FEATURES, { extraMiddlewares: [custom] });
    expect(indexOf(chain, 'ClassDecorated')).toBe(
      indexOf(chain, 'ToolErrorHandlingMiddleware') - 1,
    );
  });

  it('类锚点按类名命中内置实例（链上是普通对象，构造函数比对不了）', () => {
    // 文档里的用法一：@Next 装饰自定义类，锚点给内置中间件的**类名**。
    // 链上实例是 createMiddleware 造的普通对象（constructor 恒为 Object），
    // 只能靠「类名 === 实例 name」命中。
    const AnchorClass = class ToolErrorHandlingMiddleware {};
    const Decorated = class CustomAfterClassAnchor {};
    Next(AnchorClass)(Decorated as never);
    const custom = createMiddleware({ name: 'CustomAfterClassAnchor' }) as AgentMiddleware;
    Object.defineProperty(custom, 'constructor', { value: Decorated });

    const { chain } = assembleFromFeatures(DEFAULT_FEATURES, { extraMiddlewares: [custom] });

    expect(indexOf(chain, 'CustomAfterClassAnchor')).toBe(
      indexOf(chain, 'ToolErrorHandlingMiddleware') + 1,
    );
  });

  it('锚点未命中时告警一次，同键重复装配不再刷屏', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 与「锚点不在链上」用例同源：DEFAULT_FEATURES 没有 MemoryMiddleware
      const build = () => positioned('CustomWarnOnce', memoryMiddleware, 'prev');
      const warnings = () =>
        warn.mock.calls.filter(([msg]) => String(msg).includes('CustomWarnOnce'));

      const { chain } = assembleFromFeatures(DEFAULT_FEATURES, { extraMiddlewares: [build()] });

      expect(warnings()).toHaveLength(1);
      expect(indexOf(chain, 'CustomWarnOnce')).toBe(chain.length - 1); // 仍然不丢中间件

      assembleFromFeatures(DEFAULT_FEATURES, { extraMiddlewares: [build()] });
      expect(warnings()).toHaveLength(1); // 第二次同键保持静默
    } finally {
      warn.mockRestore();
    }
  });

  it('无锚点的自定义中间件追加到链尾', () => {
    const custom = createMiddleware({ name: 'PlainCustom' }) as AgentMiddleware;
    const { chain } = assembleFromFeatures(DEFAULT_FEATURES, { extraMiddlewares: [custom] });

    expect(indexOf(chain, 'PlainCustom')).toBe(chain.length - 1);
  });

  it('锚点不在链上时退化为追加链尾（不丢失中间件）', () => {
    // DEFAULT_FEATURES.memory = false → 链上没有 MemoryMiddleware，锚点缺席
    const custom = positioned('CustomOrphan', memoryMiddleware, 'prev');
    const { chain } = assembleFromFeatures(DEFAULT_FEATURES, { extraMiddlewares: [custom] });

    expect(indexOf(chain, 'MemoryMiddleware')).toBe(-1);
    expect(indexOf(chain, 'CustomOrphan')).toBe(chain.length - 1);
  });

  it('多个自定义中间件按顺序逐个插入，互不覆盖', () => {
    const before = positioned('CustomA', toolErrorHandlingMiddleware, 'prev');
    const plain = createMiddleware({ name: 'CustomB' }) as AgentMiddleware;
    const { chain } = assembleFromFeatures(DEFAULT_FEATURES, {
      extraMiddlewares: [before, plain],
    });

    expect(indexOf(chain, 'CustomA')).toBe(indexOf(chain, 'ToolErrorHandlingMiddleware') - 1);
    expect(indexOf(chain, 'CustomB')).toBe(chain.length - 1);
  });

  it('extraMiddlewares 为空或未传时链形态不变', () => {
    const baseline = names(assembleFromFeatures(DEFAULT_FEATURES, {}).chain);
    expect(names(assembleFromFeatures(DEFAULT_FEATURES, { extraMiddlewares: [] }).chain)).toEqual(
      baseline,
    );
  });
});
