import { describe, expect, it } from 'vitest';
import type { AgentMiddleware } from 'langchain';
import {
  DEFAULT_FEATURES,
  Next,
  Prev,
  resolveMiddlewareAnchor,
  anchorDisplayName,
  middlewareDisplayName,
  type PositionedMiddleware,
} from './features';

// AgentMiddleware 在 langchain 1.x 主入口仅作为类型导出（运行时无此类），
// 测试锚点类用普通 class + 类型 cast 即可（Next/Prev 只写锚点字段，不实例化）。
type MiddlewareCtor = new (...args: unknown[]) => AgentMiddleware;
const AnchorMiddleware = class AnchorMiddleware {} as unknown as MiddlewareCtor;
const OtherMiddleware = class OtherMiddleware {} as unknown as MiddlewareCtor;

describe('DEFAULT_FEATURES', () => {
  it('库级默认全部关闭（服务级由 _service.ts 显式开启）', () => {
    expect(DEFAULT_FEATURES).toEqual({
      sandbox: false,
      memory: false,
      summarization: false,
      todo: false,
      vision: false,
      autoTitle: false,
      threadData: false,
      uploads: false,
      guardrail: false,
    });
  });

  it('未设置 subagents 键（undefined = 默认启用，注入 task 工具）', () => {
    expect(DEFAULT_FEATURES.subagents).toBeUndefined();
  });
});

describe('Next/Prev 装饰器', () => {
  // 装饰器与函数调用等价（@Next(X) class A 即 Next(X)(A)），测试用后者以兼容
  // Node 原生 type-stripping 转译路径（不支持实验性装饰器语法）。
  it('Next 把锚点写到类的 _nextAnchor', () => {
    class AfterAnchor {}
    Next(AnchorMiddleware)(AfterAnchor as unknown as MiddlewareCtor);

    const ctor = AfterAnchor as unknown as PositionedMiddleware;
    expect(ctor._nextAnchor).toBe(AnchorMiddleware);
    expect(ctor._prevAnchor).toBeUndefined();
  });

  it('Prev 把锚点写到类的 _prevAnchor', () => {
    class BeforeOther {}
    Prev(OtherMiddleware)(BeforeOther as unknown as MiddlewareCtor);

    const ctor = BeforeOther as unknown as PositionedMiddleware;
    expect(ctor._prevAnchor).toBe(OtherMiddleware);
    expect(ctor._nextAnchor).toBeUndefined();
  });

  it('未装饰的类不携带锚点', () => {
    class Plain {}

    const ctor = Plain as unknown as PositionedMiddleware;
    expect(ctor._nextAnchor).toBeUndefined();
    expect(ctor._prevAnchor).toBeUndefined();
  });
});

describe('resolveMiddlewareAnchor / 显示名', () => {
  it('实例 own 字段优先于构造函数静态字段，_prevAnchor 优先于 _nextAnchor', () => {
    const Decorated = class DecoratedMiddleware {};
    Next(OtherMiddleware)(Decorated as unknown as MiddlewareCtor);
    const mw = { name: 'Mw' } as AgentMiddleware;
    Object.defineProperty(mw, 'constructor', { value: Decorated });

    // 实例带 _prevAnchor 时构造函数上的 _nextAnchor 不参与
    (mw as PositionedMiddleware)._prevAnchor = AnchorMiddleware;
    expect(resolveMiddlewareAnchor(mw)).toEqual({ anchor: AnchorMiddleware, side: 'prev' });
  });

  it('实例无锚点时回退读构造函数静态字段（@Next/@Prev 装饰类场景）', () => {
    const Decorated = class DecoratedMiddleware {};
    Next(AnchorMiddleware)(Decorated as unknown as MiddlewareCtor);
    const mw = { name: 'Mw' } as AgentMiddleware;
    Object.defineProperty(mw, 'constructor', { value: Decorated });

    expect(resolveMiddlewareAnchor(mw)).toEqual({ anchor: AnchorMiddleware, side: 'next' });
  });

  it('两处都无锚点返回 null', () => {
    expect(resolveMiddlewareAnchor({ name: 'Plain' } as AgentMiddleware)).toBeNull();
  });

  it('显示名：类取类名，实例取 name，缺省回 (anonymous)', () => {
    expect(anchorDisplayName(AnchorMiddleware)).toBe('AnchorMiddleware');
    expect(anchorDisplayName({ name: 'InstAnchor' } as AgentMiddleware)).toBe('InstAnchor');
    expect(anchorDisplayName({} as AgentMiddleware)).toBe('(anonymous)');
    expect(middlewareDisplayName({ name: 'Mw' } as AgentMiddleware)).toBe('Mw');
    expect(middlewareDisplayName({} as AgentMiddleware)).toBe('(anonymous)');
  });
});
