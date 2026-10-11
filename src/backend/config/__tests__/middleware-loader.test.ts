import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getExtraMiddlewares, resetExtraMiddlewares } from '@deerflow-harness';

import { loadConfiguredExtraMiddlewares, loadMiddlewareModule } from '../middleware-loader';

// 测试文件所在目录（src/backend/config/__tests__），fixtures 相对它解析
const baseDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(baseDir, 'fixtures');

afterEach(() => {
  resetExtraMiddlewares();
});

const names = (mwList: unknown[]) => mwList.map((m) => (m as { name: string }).name);

describe('loadMiddlewareModule', () => {
  it('默认导出实例', async () => {
    const list = await loadMiddlewareModule('./fixtures/mw-instance.cjs', baseDir);
    expect(names(list)).toEqual(['FixtureCjs']);
  });

  it('默认导出 sync 工厂函数', async () => {
    const list = await loadMiddlewareModule('./fixtures/mw-factory.cjs', baseDir);
    expect(names(list)).toEqual(['FixtureFactory']);
  });

  it('默认导出 async 工厂函数', async () => {
    const list = await loadMiddlewareModule('./fixtures/mw-async-factory.cjs', baseDir);
    expect(names(list)).toEqual(['FixtureAsync']);
  });

  it('命名导出 middleware', async () => {
    const list = await loadMiddlewareModule('./fixtures/mw-named.cjs', baseDir);
    expect(names(list)).toEqual(['FixtureNamed']);
  });

  it('命名导出 middlewares 数组保序', async () => {
    const list = await loadMiddlewareModule('./fixtures/mw-array.cjs', baseDir);
    expect(names(list)).toEqual(['FixtureArrayA', 'FixtureArrayB']);
  });

  it('无任何可识别导出 → throw', async () => {
    await expect(loadMiddlewareModule('./fixtures/mw-empty.cjs', baseDir)).rejects.toThrow(
      /exports no middleware/,
    );
  });

  it('相对路径不存在 → throw 含 specifier', async () => {
    await expect(loadMiddlewareModule('./fixtures/nope.cjs', baseDir)).rejects.toThrow(
      /cannot resolve middleware module '\.\/fixtures\/nope\.cjs'/,
    );
  });

  it('裸包名解析失败 → throw 含包名', async () => {
    await expect(
      loadMiddlewareModule('definitely-not-a-real-package-xyz', baseDir),
    ).rejects.toThrow(/cannot resolve middleware module 'definitely-not-a-real-package-xyz'/);
  });

  it('绝对路径也可加载', async () => {
    const list = await loadMiddlewareModule(path.join(fixturesDir, 'mw-instance.cjs'), baseDir);
    expect(names(list)).toEqual(['FixtureCjs']);
  });
});

describe('loadConfiguredExtraMiddlewares', () => {
  it('按声明序注册进 both scope', async () => {
    await loadConfiguredExtraMiddlewares(
      ['./fixtures/mw-instance.cjs', './fixtures/mw-array.cjs'],
      baseDir,
    );
    expect(names(getExtraMiddlewares('lead'))).toEqual([
      'FixtureCjs',
      'FixtureArrayA',
      'FixtureArrayB',
    ]);
    expect(names(getExtraMiddlewares('subagent'))).toEqual([
      'FixtureCjs',
      'FixtureArrayA',
      'FixtureArrayB',
    ]);
  });

  it('任一模块失败 → 抛错且不留半注册（先于加载完成）', async () => {
    await expect(
      loadConfiguredExtraMiddlewares(
        ['./fixtures/mw-instance.cjs', './fixtures/nope.cjs'],
        baseDir,
      ),
    ).rejects.toThrow(/cannot resolve/);
    // 抛错发生在第二个 spec，第一个已注册——顺序加载语义，测试锁定该行为
    expect(names(getExtraMiddlewares('lead'))).toEqual(['FixtureCjs']);
  });
});
