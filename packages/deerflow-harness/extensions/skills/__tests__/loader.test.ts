/**
 * skill loader 测试：资源枚举 / 摘要提取 / enabled 合并 / 缓存签名失效。
 *
 * fixtures 用 mkdtemp 临时目录 + DEERFLOW_SKILLS_DIR / DEERFLOW_EXTENSIONS_CONFIG_PATH
 * env（paths.ts 每次调用现读 env）；resetSkillCache / resetExtensionsConfigStore
 * 隔离用例间的模块级缓存。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetExtensionsConfigStore } from '../../config-store';
import {
  createCustomSkill,
  enumerateResources,
  extractResourceSummary,
  getEnabledSkillsSignature,
  loadEnabledSkills,
  loadSkills,
  resetSkillCache,
} from '../loader';

let tmpRoot: string;

async function writeFile(rel: string, content: string): Promise<void> {
  const abs = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

/** 写入一个完整 skill（含 frontmatter），可附带 references/scripts。 */
async function writeSkill(
  category: 'public' | 'custom',
  name: string,
  opts: {
    description?: string;
    body?: string;
    refs?: Record<string, string>;
    scripts?: Record<string, string>;
  } = {},
): Promise<void> {
  const desc = opts.description ?? `${name} description`;
  await writeFile(
    `skills/${category}/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n${opts.body ?? `# ${name} body\n\nworkflow`}`,
  );
  for (const [rel, content] of Object.entries(opts.refs ?? {})) {
    await writeFile(`skills/${category}/${name}/references/${rel}`, content);
  }
  for (const [rel, content] of Object.entries(opts.scripts ?? {})) {
    await writeFile(`skills/${category}/${name}/scripts/${rel}`, content);
  }
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-loader-'));
  process.env.DEERFLOW_SKILLS_DIR = path.join(tmpRoot, 'skills');
  process.env.DEERFLOW_EXTENSIONS_CONFIG_PATH = path.join(tmpRoot, 'ext-config.json');
  resetSkillCache();
  resetExtensionsConfigStore();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.DEERFLOW_SKILLS_DIR;
  delete process.env.DEERFLOW_EXTENSIONS_CONFIG_PATH;
  resetSkillCache();
  resetExtensionsConfigStore();
});

describe('enumerateResources', () => {
  it('递归枚举 references 与 scripts，path 为 POSIX 相对路径、kind 正确', async () => {
    await writeSkill('public', 'demo', {
      refs: {
        'guide.md': '# Guide Title\n\nbody',
        'nested/deep.md': '## Nested Heading\n\nbody',
      },
      scripts: { 'run.py': '#!/usr/bin/env python3\nprint("hi")' },
    });
    const resources = await enumerateResources(path.join(tmpRoot, 'skills/public/demo'));
    expect(resources.map((r) => [r.path, r.kind])).toEqual([
      ['references/guide.md', 'reference'],
      ['references/nested/deep.md', 'reference'],
      ['scripts/run.py', 'script'],
    ]);
  });

  it('跳过点文件与点目录', async () => {
    await writeSkill('public', 'demo', {
      refs: { 'ok.md': '# OK', '.hidden.md': '# HIDDEN' },
    });
    await writeFile('skills/public/demo/references/.dotdir/inside.md', '# INSIDE');
    const resources = await enumerateResources(path.join(tmpRoot, 'skills/public/demo'));
    expect(resources.map((r) => r.path)).toEqual(['references/ok.md']);
  });

  it('超过 50 个文件时按排序截断为 50，且顺序确定', async () => {
    const refs: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) {
      refs[`f${String(i).padStart(2, '0')}.md`] = `# F${i}`;
    }
    await writeSkill('public', 'demo', { refs });
    const resources = await enumerateResources(path.join(tmpRoot, 'skills/public/demo'));
    expect(resources).toHaveLength(50);
    expect(resources[0].path).toBe('references/f00.md');
    expect(resources[49].path).toBe('references/f49.md');
  });
});

describe('extractResourceSummary', () => {
  it('取首个 markdown 标题并去行内格式', async () => {
    const content = 'intro line\n## [Link](https://x) with `code` and *em*\n\nbody';
    expect(extractResourceSummary(content, 'references/a.md')).toBe('Link with code and em');
  });

  it('无标题时兜底首个非空行', () => {
    expect(extractResourceSummary('\n\nfirst line here\nsecond', 'references/a.md')).toBe(
      'first line here',
    );
  });

  it('脚本跳过 shebang、剥行首 # 注释符', () => {
    expect(
      extractResourceSummary(
        '#!/usr/bin/env python3\n# Analyze the data\nimport os',
        'scripts/a.py',
      ),
    ).toBe('Analyze the data');
  });

  it('超长摘要截断 120 字符', () => {
    const long = '# ' + 'w'.repeat(200);
    const summary = extractResourceSummary(long, 'references/a.md');
    expect(summary.length).toBe(121); // 120 + 省略号
    expect(summary.endsWith('…')).toBe(true);
  });

  it('空内容返回空串', () => {
    expect(extractResourceSummary('', 'references/a.md')).toBe('');
  });
});

describe('loadSkills', () => {
  it('挂载 resources 与 summary，配置缺席时 enabled=false，按 name 排序', async () => {
    await writeSkill('public', 'zeta', {
      body: '# Zeta Overview\n\nworkflow',
      refs: { 'guide.md': '# Zeta Guide' },
    });
    await writeSkill('public', 'alpha', { body: 'Alpha body' });

    const skills = await loadSkills();
    expect(skills.map((s) => s.name)).toEqual(['alpha', 'zeta']);
    expect(skills[1].resources).toEqual([
      { path: 'references/guide.md', summary: 'Zeta Guide', kind: 'reference' },
    ]);
    expect(skills[1].summary).toBe('Zeta Overview');
    expect(skills.every((s) => s.enabled === false)).toBe(true);
  });

  it('custom 同名覆盖 public（含 resources）', async () => {
    await writeSkill('public', 'demo', { body: 'PUBLIC BODY', refs: { 'p.md': '# Public' } });
    await writeSkill('custom', 'demo', { body: 'CUSTOM BODY', refs: { 'c.md': '# Custom' } });

    const skills = await loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].body).toBe('CUSTOM BODY');
    expect(skills[0].resources.map((r) => r.path)).toEqual(['references/c.md']);
  });

  it('内容级编辑（目录 mtime 不变）也触发缓存失效', async () => {
    await writeSkill('public', 'demo', { body: 'FIRST BODY' });
    const before = await loadSkills();
    expect(before[0].body).toBe('FIRST BODY');

    // 原地改写 SKILL.md（同路径，父目录 mtime 不变），显式 bump mtime 保证跨文件系统确定性
    const skillFile = path.join(tmpRoot, 'skills/public/demo/SKILL.md');
    const stat = await fs.stat(skillFile);
    await fs.writeFile(
      skillFile,
      '---\nname: demo\ndescription: demo description\n---\n\nSECOND BODY',
      'utf-8',
    );
    await fs.utimes(skillFile, stat.atime, new Date(Date.now() + 2000));

    const after = await loadSkills();
    expect(after[0].body).toBe('SECOND BODY');
  });

  it('frontmatter 损坏的 skill 被跳过；修复后（mtime 变化）重新可见', async () => {
    await writeFile('skills/public/demo/SKILL.md', 'no frontmatter here');
    expect(await loadSkills()).toHaveLength(0);

    await writeSkill('public', 'demo', { body: 'FIXED' });
    const skillFile = path.join(tmpRoot, 'skills/public/demo/SKILL.md');
    const stat = await fs.stat(skillFile);
    await fs.utimes(skillFile, stat.atime, new Date(Date.now() + 2000));

    const skills = await loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].body).toBe('FIXED');
  });
});

describe('getEnabledSkillsSignature', () => {
  async function enable(name: string): Promise<void> {
    await writeFile('ext-config.json', JSON.stringify({ skills: { [name]: { enabled: true } } }));
    resetExtensionsConfigStore();
  }

  it('覆盖 name/description/摘要/资源目录，任一变化即变化', async () => {
    await writeSkill('public', 'demo', {
      body: '# Demo Overview',
      refs: { 'guide.md': '# Demo Guide' },
    });
    await enable('demo');

    const sig1 = await getEnabledSkillsSignature();
    expect(sig1).toContain('Demo Overview');
    expect(sig1).toContain('Demo Guide');

    await writeSkill('public', 'demo', {
      description: 'changed description',
      body: '# Demo Overview',
      refs: { 'guide.md': '# Demo Guide' },
    });
    resetSkillCache();
    expect(await getEnabledSkillsSignature()).not.toBe(sig1);
  });

  it('资源文件内容编辑（摘要变化）也改变签名', async () => {
    await writeSkill('public', 'demo', {
      body: '# Demo Overview',
      refs: { 'guide.md': '# OLD Summary' },
    });
    await enable('demo');
    const sig1 = await getEnabledSkillsSignature();

    const refFile = path.join(tmpRoot, 'skills/public/demo/references/guide.md');
    const stat = await fs.stat(refFile);
    await fs.writeFile(refFile, '# NEW Summary\n\nbody', 'utf-8');
    await fs.utimes(refFile, stat.atime, new Date(Date.now() + 2000));
    resetSkillCache();
    expect(await getEnabledSkillsSignature()).not.toBe(sig1);
  });

  it('未启用 skill 不进签名', async () => {
    await writeSkill('public', 'demo', { body: '# Demo' });
    await writeSkill('public', 'other', { body: '# Other' });
    await enable('demo');
    const sig = await getEnabledSkillsSignature();
    expect(sig).toContain('"name":"demo"');
    expect(sig).not.toContain('other');
    expect(await loadEnabledSkills()).toHaveLength(1);
  });
});

describe('createCustomSkill', () => {
  it('返回 resources:[] 与 summary，且下一次 loadSkills 可见', async () => {
    const created = await createCustomSkill({
      name: 'my-skill',
      content: '---\nname: my-skill\ndescription: my desc\n---\n\n# My Skill Body\n\nworkflow',
    });
    expect(created.resources).toEqual([]);
    expect(created.summary).toBe('My Skill Body');
    expect(created.enabled).toBe(false);

    const skills = await loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('my-skill');
  });

  it('frontmatter.name 与请求名不一致时抛错', async () => {
    await expect(
      createCustomSkill({
        name: 'my-skill',
        content: '---\nname: other-name\ndescription: d\n---\n\nbody',
      }),
    ).rejects.toThrow(/must match/);
  });
});
