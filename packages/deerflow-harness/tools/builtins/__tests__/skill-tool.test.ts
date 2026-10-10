/**
 * skill 工具测试：read（默认 SKILL.md / 指定资源 / 拒绝路径）/ run（沙箱执行
 * 与降级）/ 纯函数单元（normalizeResourcePath / quoteArgs / interpreterFromShebang）。
 *
 * fixtures 用 mkdtemp 临时目录 + DEERFLOW_SKILLS_DIR / DEERFLOW_EXTENSIONS_CONFIG_PATH
 * env；setSandboxProvider 注入假 provider 记录 writeFile / executeCommand 调用。
 * 工具调用走公开 invoke（与 view-image-tool.test.ts 同款：state / configurable
 * 由 ToolNode 在生产路径注入）。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetExtensionsConfigStore } from '../../../extensions/config-store';
import { resetSkillCache } from '../../../extensions/skills';
import type { ThreadDirectories } from '../../../sandbox/paths';
import { resetSandboxProvider, setSandboxProvider } from '../../../sandbox/provider-factory';
import type { GlobResult, GrepResult } from '../../../sandbox/sandbox';
import { Sandbox } from '../../../sandbox/sandbox';
import { SandboxProvider } from '../../../sandbox/sandbox-provider';
import { interpreterFromShebang, normalizeResourcePath, quoteArgs, skillTool } from '../skill-tool';

interface SkillToolInput {
  skill: string;
  resource?: string;
  action?: 'read' | 'run';
  args?: string;
}

async function callTool(
  input: SkillToolInput,
  runtime: { state?: unknown; threadId?: string } = {},
): Promise<string> {
  // state / config 由 ToolNode 在 config 上额外注入，公开的 invoke 配置类型
  // 只声明 RunnableConfig 部分 —— 单层断言，与生产代码读 runtime 同一外部边界。
  // configurable 嵌套在 config.config 下（LangGraph 内部 config 的形态，ToolNode
  // 原样传给 tool.invoke），与 resolveThreadId 读 runtime.config.configurable 对齐。
  const config = {
    state: runtime.state,
    config: runtime.threadId ? { configurable: { thread_id: runtime.threadId } } : undefined,
  } as unknown as Parameters<typeof skillTool.invoke>[1];
  return skillTool.invoke(input, config) as Promise<string>;
}

/** 记录写入与命令执行的假沙箱（executeCommand 行为可注入）。 */
class FakeSandbox extends Sandbox {
  written: Array<{ filePath: string; content: string }> = [];
  commands: string[] = [];
  execImpl: (command: string) => Promise<string> = async () => 'fake-output';

  constructor() {
    super('fake-sandbox');
  }

  async executeCommand(command: string): Promise<string> {
    this.commands.push(command);
    return this.execImpl(command);
  }
  async readFile(): Promise<string> {
    return '';
  }
  async listDir(): Promise<string[]> {
    return [];
  }
  async writeFile(filePath: string, content: string): Promise<void> {
    this.written.push({ filePath, content });
  }
  async glob(): Promise<GlobResult> {
    return { matches: [], truncated: false };
  }
  async grep(): Promise<GrepResult> {
    return { matches: [], truncated: false };
  }
}

class FakeProvider extends SandboxProvider {
  readonly sandbox = new FakeSandbox();
  readonly dirs: ThreadDirectories;
  secure = false;
  acquireImpl: () => string = () => this.sandbox.id;

  constructor(root: string) {
    super();
    this.dirs = {
      userData: path.join(root, 'user-data'),
      workspace: path.join(root, 'ws'),
      uploads: path.join(root, 'uploads'),
      outputs: path.join(root, 'outputs'),
    };
  }

  acquire(): string {
    return this.acquireImpl();
  }
  get(sandboxId: string): Sandbox | null {
    return sandboxId === this.sandbox.id ? this.sandbox : null;
  }
  release(): void {}
  isSecureIsolation(): boolean {
    return this.secure;
  }
  threadDirectories(): ThreadDirectories {
    return this.dirs;
  }
}

let tmpRoot: string;

async function writeFile(rel: string, content: string): Promise<void> {
  const abs = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

/** 写入一个 public skill（含可选 resources）并在扩展配置中启用（默认）。 */
async function setupSkill(
  name: string,
  opts: {
    body?: string;
    refs?: Record<string, string>;
    scripts?: Record<string, string>;
    enabled?: boolean;
  } = {},
): Promise<void> {
  await writeFile(
    `skills/public/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n${
      opts.body ?? `# ${name}\n\nBODY-MARKER-${name}`
    }`,
  );
  for (const [rel, content] of Object.entries(opts.refs ?? {})) {
    await writeFile(`skills/public/${name}/references/${rel}`, content);
  }
  for (const [rel, content] of Object.entries(opts.scripts ?? {})) {
    await writeFile(`skills/public/${name}/scripts/${rel}`, content);
  }
  await writeFile(
    'ext-config.json',
    JSON.stringify({ skills: { [name]: { enabled: opts.enabled ?? true } } }),
  );
  resetSkillCache();
  resetExtensionsConfigStore();
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-tool-'));
  process.env.DEERFLOW_SKILLS_DIR = path.join(tmpRoot, 'skills');
  process.env.DEERFLOW_EXTENSIONS_CONFIG_PATH = path.join(tmpRoot, 'ext-config.json');
  delete process.env.DEERFLOW_ALLOW_HOST_BASH;
  delete process.env.DEERFLOW_SKILL_SCRIPT_TIMEOUT_MS;
  resetSkillCache();
  resetExtensionsConfigStore();
  resetSandboxProvider();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.DEERFLOW_SKILLS_DIR;
  delete process.env.DEERFLOW_EXTENSIONS_CONFIG_PATH;
  delete process.env.DEERFLOW_ALLOW_HOST_BASH;
  delete process.env.DEERFLOW_SKILL_SCRIPT_TIMEOUT_MS;
  resetSkillCache();
  resetExtensionsConfigStore();
  resetSandboxProvider();
});

describe('skill 工具 —— read', () => {
  it('省略 resource 返回 SKILL.md 正文（frontmatter 已剥离）', async () => {
    await setupSkill('demo', { body: '## Workflow\n\nstep 1 BODY-MARKER-demo' });
    const out = await callTool({ skill: 'demo' });
    expect(out).toContain('BODY-MARKER-demo');
    expect(out).not.toContain('name: demo');
  });

  it('指定 references 资源返回文件内容', async () => {
    await setupSkill('demo', { refs: { 'guide.md': '# Guide\n\nREF-MARKER' } });
    const out = await callTool({ skill: 'demo', resource: 'references/guide.md' });
    expect(out).toContain('REF-MARKER');
  });

  it('未知或未启用的 skill 拒绝并提示', async () => {
    await setupSkill('alpha', { enabled: false });
    const out = await callTool({ skill: 'alpha' });
    expect(out).toContain('未找到已启用的技能 "alpha"');
    expect(out).toContain('当前没有启用任何技能');
  });

  it('未知 skill 列出可用技能名', async () => {
    await setupSkill('alpha');
    const out = await callTool({ skill: 'beta' });
    expect(out).toContain('可用技能：alpha');
  });

  it.each(['../x.md', '/abs/x.md', 'C:/x.md', 'a//b.md', 'references/'])(
    '拒绝非法 resource 路径：%s',
    async (resource) => {
      await setupSkill('demo');
      const out = await callTool({ skill: 'demo', resource });
      expect(out).toContain('resource');
      expect(out).not.toContain('BODY-MARKER-demo');
    },
  );

  it('symlink 逃逸到 skill 目录之外被拒绝', async () => {
    await setupSkill('demo');
    await writeFile('outside-secret.txt', 'SECRET');
    await fs.mkdir(path.join(tmpRoot, 'skills/public/demo/references'), { recursive: true });
    await fs.symlink(
      path.join(tmpRoot, 'outside-secret.txt'),
      path.join(tmpRoot, 'skills/public/demo/references/leak.md'),
    );
    const out = await callTool({ skill: 'demo', resource: 'references/leak.md' });
    expect(out).toContain('资源越界');
    expect(out).not.toContain('SECRET');
  });

  it('超过 100KB 截断并提示', async () => {
    await setupSkill('demo', { refs: { 'big.md': `# Big\n\n${'x'.repeat(110_000)}` } });
    const out = await callTool({ skill: 'demo', resource: 'references/big.md' });
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(100_500);
  });
});

describe('skill 工具 —— run', () => {
  const SCRIPT_BODY = '#!/usr/bin/env python3\nprint("hi")  # SECRET-SCRIPT-MARKER';

  it('复制脚本到 workspace 执行并返回输出，脚本内容不进输出，finally 清理副本', async () => {
    await setupSkill('demo', { scripts: { 'hello.py': SCRIPT_BODY } });
    const fake = new FakeProvider(tmpRoot);
    fake.sandbox.execImpl = async () => 'out-42\n';
    setSandboxProvider(fake);
    process.env.DEERFLOW_ALLOW_HOST_BASH = 'true';

    const out = await callTool(
      { skill: 'demo', action: 'run', resource: 'scripts/hello.py', args: '--flag 1' },
      { threadId: 't-1' },
    );

    expect(out).toContain('out-42');
    expect(out).not.toContain('SECRET-SCRIPT-MARKER');
    expect(fake.sandbox.written).toHaveLength(1);
    expect(fake.sandbox.written[0].filePath).toBe(path.join(fake.dirs.workspace, 'hello.py'));
    expect(fake.sandbox.written[0].content).toBe(SCRIPT_BODY);
    expect(fake.sandbox.commands).toHaveLength(2);
    expect(fake.sandbox.commands[0]).toBe(
      `cd ${JSON.stringify(fake.dirs.workspace)} && python3 "hello.py" "--flag" "1"`,
    );
    expect(fake.sandbox.commands[1]).toBe(
      `rm -f ${JSON.stringify(path.join(fake.dirs.workspace, 'hello.py'))}`,
    );
  });

  it('args 逐 token 惰性引用——`; rm -rf /` 只是字符串参数，不构成新命令', async () => {
    await setupSkill('demo', { scripts: { 'hello.py': SCRIPT_BODY } });
    const fake = new FakeProvider(tmpRoot);
    setSandboxProvider(fake);
    process.env.DEERFLOW_ALLOW_HOST_BASH = 'true';

    await callTool(
      { skill: 'demo', action: 'run', resource: 'scripts/hello.py', args: '; rm -rf /' },
      { threadId: 't-1' },
    );

    expect(fake.sandbox.commands[0]).toBe(
      `cd ${JSON.stringify(fake.dirs.workspace)} && python3 "hello.py" ";" "rm" "-rf" "/"`,
    );
  });

  it('action=run 只认 scripts 清单条目（references 被拒）', async () => {
    await setupSkill('demo', { refs: { 'guide.md': '# G' } });
    const out = await callTool(
      { skill: 'demo', action: 'run', resource: 'references/guide.md' },
      { threadId: 't-1' },
    );
    expect(out).toContain('不在该技能的脚本清单中');
  });

  it('非隔离后端无 host-bash 时门控降级：回传脚本内容且绝不执行', async () => {
    await setupSkill('demo', { scripts: { 'hello.py': 'print("SECRET-SCRIPT-MARKER")' } });
    const fake = new FakeProvider(tmpRoot);
    setSandboxProvider(fake);
    // DEERFLOW_ALLOW_HOST_BASH 已删除（beforeEach）——非隔离后端默认禁执行

    const out = await callTool(
      { skill: 'demo', action: 'run', resource: 'scripts/hello.py' },
      { threadId: 't-1' },
    );

    expect(out).toContain('脚本执行被禁用');
    expect(out).toContain('SECRET-SCRIPT-MARKER');
    expect(fake.sandbox.commands).toHaveLength(0);
  });

  it('沙箱不可用时降级回传脚本内容', async () => {
    await setupSkill('demo', { scripts: { 'hello.py': 'print("SECRET-SCRIPT-MARKER")' } });
    const fake = new FakeProvider(tmpRoot);
    fake.acquireImpl = () => {
      throw new Error('acquire boom');
    };
    setSandboxProvider(fake);
    process.env.DEERFLOW_ALLOW_HOST_BASH = 'true';

    const out = await callTool(
      { skill: 'demo', action: 'run', resource: 'scripts/hello.py' },
      { threadId: 't-1' },
    );

    expect(out).toContain('沙箱不可用');
    expect(out).toContain('SECRET-SCRIPT-MARKER');
  });

  it('执行失败降级回传脚本内容', async () => {
    await setupSkill('demo', { scripts: { 'hello.py': 'print("SECRET-SCRIPT-MARKER")' } });
    const fake = new FakeProvider(tmpRoot);
    fake.sandbox.execImpl = async () => {
      throw new Error('exec boom');
    };
    setSandboxProvider(fake);
    process.env.DEERFLOW_ALLOW_HOST_BASH = 'true';

    const out = await callTool(
      { skill: 'demo', action: 'run', resource: 'scripts/hello.py' },
      { threadId: 't-1' },
    );

    expect(out).toContain('脚本执行失败');
    expect(out).toContain('SECRET-SCRIPT-MARKER');
  });

  it('超过超时上限放弃等待并降级（env 可调小）', async () => {
    await setupSkill('demo', { scripts: { 'hello.py': 'print("SECRET-SCRIPT-MARKER")' } });
    const fake = new FakeProvider(tmpRoot);
    fake.sandbox.execImpl = () => new Promise(() => {}); // 永不 settle
    setSandboxProvider(fake);
    process.env.DEERFLOW_ALLOW_HOST_BASH = 'true';
    process.env.DEERFLOW_SKILL_SCRIPT_TIMEOUT_MS = '150';

    const out = await callTool(
      { skill: 'demo', action: 'run', resource: 'scripts/hello.py' },
      { threadId: 't-1' },
    );

    expect(out).toContain('脚本执行超时');
    expect(out).toContain('150ms');
    expect(out).toContain('SECRET-SCRIPT-MARKER');
  });
});

describe('skill 工具 —— 纯函数', () => {
  it('normalizeResourcePath 归一 \\ 并拒绝非法路径', () => {
    expect(normalizeResourcePath('references/a.md')).toEqual({ path: 'references/a.md' });
    expect(normalizeResourcePath('scripts\\a.py')).toEqual({ path: 'scripts/a.py' });
    for (const bad of ['../x', '/x', 'C:/x', 'a//b', 'a/./b', 'a/../b', 'dir/']) {
      expect('error' in normalizeResourcePath(bad)).toBe(true);
    }
  });

  it('quoteArgs 逐 token JSON 引用', () => {
    expect(quoteArgs(undefined)).toBe('');
    expect(quoteArgs('  --flag 1  ')).toBe('"--flag" "1"');
    expect(quoteArgs('; rm -rf /')).toBe('";" "rm" "-rf" "/"');
  });

  it('interpreterFromShebang 推断解释器', () => {
    expect(interpreterFromShebang('#!/usr/bin/env python3\nprint(1)')).toBe('python3');
    expect(interpreterFromShebang('#!/usr/bin/python\nprint(1)')).toBe('python3');
    expect(interpreterFromShebang('#!/usr/bin/env node\nx()')).toBe('node');
    expect(interpreterFromShebang('#!/bin/bash\necho x')).toBe('bash');
    expect(interpreterFromShebang('print(1)')).toBe('bash');
    expect(interpreterFromShebang('#!/usr/bin/env -S deno run\nx')).toBe('bash');
  });
});
