/**
 * skill 加载器。
 *
 * 扫描 skills/public 与 skills/custom 下各 SKILL.md，解析 frontmatter，
 * 枚举 references/ 与 scripts/ 资源（含单行摘要），合并 extensions_config.json
 * 中的 enabled 状态，按 name 去重、按 name 排序。
 *
 * 缓存：签名 = 各分类目录 mtime（捕获 skill 目录增删）+ walk 期间收集的
 * 文件 mtime（捕获内容级编辑——目录 mtime 不随文件内容变化）。签名未变时
 * 直接返回缓存实例；因此解析每次 walk 都会执行，命中时丢弃本轮结果。
 * enabled 状态每次从 configStore 实时合并（configStore 自身有 mtime 缓存）。
 *
 * enabled 默认值：启用即把 skill 的 name/description/资源目录注入系统提示
 * （L1），有 token 预算成本，因此默认 **禁用（opt-in）**——与 deer-flow
 * 沙箱场景的默认启用不同，由用户在设置界面按需开启。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getExtensionsConfigStore } from '..';
import { getCustomSkillsDir, getPublicSkillsDir, getSkillsRootDir } from '../paths';
import { parseFrontmatter } from './frontmatter';
import { type Skill, type SkillCategory, type SkillResource, validateSkillName } from './types';

interface ParsedSkill {
  name: string;
  description: string;
  license: string | null;
  body: string;
  category: SkillCategory;
  relativePath: string;
  dir: string;
  resources: SkillResource[];
  summary: string;
}

interface ParsedCache {
  skills: ParsedSkill[];
  signature: string;
}

/** 每个 skill 的资源文件数上限：防误配超大目录把资源目录撑爆提示。 */
const MAX_RESOURCE_FILES_PER_SKILL = 50;
/** 摘要只读文件头字节数（截断处可能切断多字节字符，摘要截断本就可接受）。 */
const RESOURCE_SUMMARY_READ_BYTES = 4096;
/** 摘要截断长度（字符）。 */
const RESOURCE_SUMMARY_MAX_CHARS = 120;

export interface LoadSkillsOptions {
  enabledOnly?: boolean;
}

export interface CreateCustomSkillInput {
  name: string;
  /** 完整 SKILL.md 内容（含 frontmatter）。 */
  content: string;
}

let _parsedCache: ParsedCache | null = null;

async function dirMtimeMs(dir: string): Promise<number | null> {
  try {
    const s = await fs.stat(dir);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

/** 只读文件头若干字节（摘要提取用，避免为大文件读全文）。 */
async function readFileHead(file: string, bytes: number): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } finally {
    await fh.close();
  }
}

/**
 * 从文件头提取单行摘要：优先首个 markdown 标题，兜底首个非空行
 * （脚本跳过 shebang、剥行首 `#` 注释符）；去行内格式、折叠空白、截断。
 */
export function extractResourceSummary(content: string, relativePath: string): string {
  const text = content.replace(/^﻿/, '');
  const isScript = relativePath.startsWith('scripts/');

  let summary = '';
  const heading = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text);
  if (heading) {
    summary = heading[1];
  } else {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (isScript && line.startsWith('#!')) continue;
      if (isScript && line.startsWith('#')) {
        summary = line.replace(/^#+\s*/, '');
      } else {
        summary = line;
      }
      break;
    }
  }

  summary = summary
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (summary.length > RESOURCE_SUMMARY_MAX_CHARS) {
    summary = `${summary.slice(0, RESOURCE_SUMMARY_MAX_CHARS)}…`;
  }
  return summary;
}

/**
 * 枚举 skill 目录下 references/ 与 scripts/ 的资源文件（递归，路径按字典序
 * 确定性排序，跳过点文件/点目录，每 skill 上限 MAX_RESOURCE_FILES_PER_SKILL）。
 * mtimeSink 非空时把每个文件的 mtime 收进去（供缓存签名判断内容级编辑）。
 */
export async function enumerateResources(
  skillDir: string,
  mtimeSink?: number[],
): Promise<SkillResource[]> {
  const resources: SkillResource[] = [];

  async function walkSub(sub: 'references' | 'scripts'): Promise<void> {
    async function walk(dir: string, rel: string): Promise<void> {
      if (resources.length >= MAX_RESOURCE_FILES_PER_SKILL) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      // 排序保证确定性：命中 50 上限截断时结果也稳定
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (resources.length >= MAX_RESOURCE_FILES_PER_SKILL) return;
        if (entry.name.startsWith('.')) continue;
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs, entryRel);
        } else if (entry.isFile()) {
          const mtime = await fs
            .stat(abs)
            .then((s) => s.mtimeMs)
            .catch(() => null);
          if (mtime !== null) mtimeSink?.push(mtime);
          let head = '';
          try {
            head = await readFileHead(abs, RESOURCE_SUMMARY_READ_BYTES);
          } catch {
            // 摘要失败留空，不阻断枚举
          }
          resources.push({
            path: entryRel,
            summary: extractResourceSummary(head, entryRel),
            kind: sub === 'references' ? 'reference' : 'script',
          });
        }
      }
    }

    await walk(path.join(skillDir, sub), sub);
  }

  await walkSub('references');
  await walkSub('scripts');
  return resources;
}

/** 递归查找分类目录下的 SKILL.md；命中 skill 目录后不再向下深入。 */
async function findSkillFiles(categoryPath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      results.push(path.join(dir, 'SKILL.md'));
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await walk(path.join(dir, entry.name));
      }
    }
  }

  await walk(categoryPath);
  return results;
}

async function parseSkillFile(
  skillFile: string,
  category: SkillCategory,
  categoryRoot: string,
  mtimeSink?: number[],
): Promise<ParsedSkill | null> {
  // SKILL.md mtime 先收进签名池：即便本轮解析失败（frontmatter 坏了），
  // 文件修复后的 mtime 变化也会触发缓存失效重试，而不是静默跳过到重启。
  const mtime = await fs
    .stat(skillFile)
    .then((s) => s.mtimeMs)
    .catch(() => null);
  if (mtime !== null) mtimeSink?.push(mtime);

  let content: string;
  try {
    content = await fs.readFile(skillFile, 'utf-8');
  } catch {
    return null;
  }
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;

  const name = parsed.fields.name?.trim();
  const description = parsed.fields.description?.trim();
  if (!name || !description) return null;

  const license = parsed.fields.license ? parsed.fields.license.trim() || null : null;
  const dir = path.dirname(skillFile);
  const relativePath = path.relative(categoryRoot, dir) || name;
  const resources = await enumerateResources(dir, mtimeSink);
  const summary = extractResourceSummary(parsed.body, 'SKILL.md');

  return {
    name,
    description,
    license,
    body: parsed.body,
    category,
    relativePath,
    dir,
    resources,
    summary,
  };
}

async function loadParsedSkills(): Promise<ParsedSkill[]> {
  const publicDir = getPublicSkillsDir();
  const customDir = getCustomSkillsDir();
  // 签名 = 目录 mtime（捕获 skill 目录增删）+ walk 中收集的文件 mtime
  // （捕获内容级编辑——目录 mtime 不随文件内容变化，仅靠目录签名会漏失效）。
  // 文件 mtime 只有 walk 后才能拿到，因此 walk 每次都执行（7 个内置 skill
  // 的读盘量 ~百 KB 级，可接受）；签名未变时丢弃本轮解析结果、返回缓存实例。
  const dirSignature = JSON.stringify([await dirMtimeMs(publicDir), await dirMtimeMs(customDir)]);
  const fileMtimes: number[] = [];

  const byName = new Map<string, ParsedSkill>();
  for (const category of ['public', 'custom'] as const) {
    const categoryRoot = category === 'public' ? publicDir : customDir;
    const files = (await findSkillFiles(categoryRoot)).sort();
    for (const file of files) {
      const skill = await parseSkillFile(file, category, categoryRoot, fileMtimes);
      if (skill) byName.set(skill.name, skill);
    }
  }

  const signature = JSON.stringify([dirSignature, [...fileMtimes].sort((a, b) => a - b)]);

  if (_parsedCache && _parsedCache.signature === signature) {
    return _parsedCache.skills;
  }

  const skills = [...byName.values()];
  // 并发 miss 时两个协程各自 walk、后写覆盖：幂等，结果一致
  _parsedCache = { skills, signature };
  return skills;
}

/** 加载全部 skill，合并 enabled 状态并按 name 排序。 */
export async function loadSkills(opts: LoadSkillsOptions = {}): Promise<Skill[]> {
  const parsed = await loadParsedSkills();
  const config = await getExtensionsConfigStore().load();

  let skills: Skill[] = parsed.map((p) => ({
    ...p,
    enabled: config.skills[p.name]?.enabled ?? false,
  }));

  if (opts.enabledOnly) {
    skills = skills.filter((s) => s.enabled);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** 仅返回启用的 skill（供 prompt 注入）。 */
export async function loadEnabledSkills(): Promise<Skill[]> {
  return loadSkills({ enabledOnly: true });
}

/**
 * 启用技能的 L1 注入内容全签名（name/description/摘要/资源目录，loadSkills
 * 已按 name 排序）。
 * 供 agent 实例缓存键使用：任一注入文本变化（含资源文件的内容编辑改变其
 * 摘要）即触发 agent 重建。签名不含正文——正文不经注入，由 skill 工具按需读取。
 */
export async function getEnabledSkillsSignature(): Promise<string> {
  const skills = await loadEnabledSkills();
  return JSON.stringify(
    skills.map((s) => ({
      name: s.name,
      description: s.description,
      summary: s.summary,
      resources: s.resources.map((r) => ({ path: r.path, summary: r.summary })),
    })),
  );
}

/** 重置解析缓存（新建/修改 skill 后调用）。 */
export function resetSkillCache(): void {
  _parsedCache = null;
}

/**
 * 新建自定义 skill：校验名称合法 + frontmatter.name 与请求名一致，
 * 原子写入 skills/custom/<name>/SKILL.md，并重置缓存。
 */
export async function createCustomSkill(input: CreateCustomSkillInput): Promise<Skill> {
  const name = validateSkillName(input.name);

  const parsed = parseFrontmatter(input.content);
  if (!parsed) {
    throw new Error('SKILL.md must start with a YAML frontmatter block delimited by ---.');
  }
  if (!parsed.fields.name || !parsed.fields.description) {
    throw new Error('SKILL.md frontmatter must include both name and description.');
  }
  if (parsed.fields.name.trim() !== name) {
    throw new Error(
      `Frontmatter name '${parsed.fields.name}' must match requested skill name '${name}'.`,
    );
  }

  const skillDir = path.join(getCustomSkillsDir(), name);
  const skillFile = path.join(skillDir, 'SKILL.md');
  await fs.mkdir(skillDir, { recursive: true });
  const tmpPath = path.join(skillDir, `SKILL.md.${randomUUID().replace(/-/g, '')}.tmp`);
  await fs.writeFile(tmpPath, input.content, 'utf-8');
  await fs.rename(tmpPath, skillFile);

  resetSkillCache();

  return {
    name,
    description: parsed.fields.description.trim(),
    license: parsed.fields.license ? parsed.fields.license.trim() || null : null,
    body: parsed.body,
    category: 'custom',
    relativePath: name,
    dir: skillDir,
    enabled: false,
    // 新建时目录里只有 SKILL.md；后续服务器侧放入的 references/scripts
    // 会在下一次 loadSkills 时被枚举进来（缓存已重置）
    resources: [],
    summary: extractResourceSummary(parsed.body, 'SKILL.md'),
  };
}

export function getSkillsRoot(): string {
  return getSkillsRootDir();
}
