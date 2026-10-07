/**
 * L1 渐进披露注入测试：输出含 name/description/资源目录，**不含正文**。
 */

import { describe, expect, it } from 'vitest';

import { buildSkillsSection } from '../prompt';
import type { Skill } from '../types';

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'demo',
    description: 'demo description',
    license: null,
    body: 'UNIQUE-BODY-MARKER-xyz',
    category: 'public',
    relativePath: 'demo',
    dir: '/tmp/demo',
    enabled: true,
    resources: [],
    summary: 'Demo Overview',
    ...overrides,
  };
}

describe('buildSkillsSection（L1-only）', () => {
  it('空列表返回空字符串', () => {
    expect(buildSkillsSection([])).toBe('');
  });

  it('含 name / description / 资源目录 / 摘要 / wrapper，不含正文', () => {
    const out = buildSkillsSection([
      makeSkill({
        resources: [
          { path: 'references/guide.md', summary: 'Guide Summary', kind: 'reference' },
          { path: 'scripts/run.py', summary: 'Run Summary', kind: 'script' },
        ],
      }),
    ]);

    expect(out).toContain('<available_skills>');
    expect(out).toContain('## demo');
    expect(out).toContain('demo description');
    expect(out).toContain('资源目录');
    expect(out).toContain('- SKILL.md：Demo Overview');
    expect(out).toContain('- references/guide.md：Guide Summary');
    expect(out).toContain('- scripts/run.py：Run Summary（脚本，可在沙箱中执行）');
    expect(out).toContain('调用 `skill` 工具');
    // L1-only 硬约束：正文绝不能出现在注入块里
    expect(out).not.toContain('UNIQUE-BODY-MARKER-xyz');
  });

  it('零资源 skill 只渲染 SKILL.md 行', () => {
    const out = buildSkillsSection([makeSkill()]);
    expect(out).toContain('- SKILL.md：Demo Overview');
    // 资源目录区域（列表行）不出现 references/scripts 条目
    // （提示语示例中的 "references/xxx.md" 是工具用法说明，不算目录内容）
    expect(out).not.toMatch(/^- references\//m);
    expect(out).not.toMatch(/^- scripts\//m);
  });

  it('摘要为空时省略冒号后缀', () => {
    const out = buildSkillsSection([
      makeSkill({
        summary: '',
        resources: [{ path: 'references/a.md', summary: '', kind: 'reference' }],
      }),
    ]);
    expect(out).toContain('- SKILL.md\n');
    expect(out).toContain('- references/a.md\n');
  });

  it('多个 skill 间以空行分隔、按传入顺序渲染', () => {
    const out = buildSkillsSection([makeSkill(), makeSkill({ name: 'zeta' })]);
    const demoIdx = out.indexOf('## demo');
    const zetaIdx = out.indexOf('## zeta');
    expect(demoIdx).toBeGreaterThan(-1);
    expect(zetaIdx).toBeGreaterThan(demoIdx);
  });
});
