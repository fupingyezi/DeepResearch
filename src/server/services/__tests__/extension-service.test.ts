/**
 * ExtensionService 测试：listSkills / createSkill 对 Skill 新字段（resources/
 * summary）是纯透传——新架构的字段由 harness loader 产出，服务层零转换。
 */

import { describe, expect, it, vi } from 'vitest';

import type { Skill } from '@/deerflow-harness';
import { createExtensionService, type ExtensionServiceDeps } from '../extension-service';

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'demo',
    description: 'demo description',
    license: null,
    body: 'body',
    category: 'custom',
    relativePath: 'demo',
    dir: '/tmp/demo',
    enabled: true,
    resources: [],
    summary: '',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ExtensionServiceDeps> = {}): ExtensionServiceDeps {
  return {
    store: {} as ExtensionServiceDeps['store'],
    loadSkills: vi.fn().mockResolvedValue([]),
    createCustomSkill: vi.fn(),
    resetMcpClient: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ExtensionService —— skill 新字段透传', () => {
  it('listSkills 原样透传 resources/summary（不剥离不转换）', async () => {
    const skill = makeSkill({
      resources: [
        { path: 'references/a.md', summary: 'A', kind: 'reference' },
        { path: 'scripts/run.py', summary: 'R', kind: 'script' },
      ],
      summary: 'Overview',
    });
    const deps = makeDeps({ loadSkills: vi.fn().mockResolvedValue([skill]) });

    const listed = await createExtensionService(deps).listSkills();

    expect(listed).toHaveLength(1);
    expect(listed[0].resources).toEqual(skill.resources);
    expect(listed[0].summary).toBe('Overview');
  });

  it('createSkill 返回新架构默认值 resources: [] 与 summary', async () => {
    const deps = makeDeps({
      createCustomSkill: vi.fn().mockResolvedValue(makeSkill()),
    });

    const created = await createExtensionService(deps).createSkill('demo', 'body');

    expect(created.resources).toEqual([]);
    expect(created.summary).toBe('');
  });
});
