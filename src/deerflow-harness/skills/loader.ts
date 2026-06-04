/**
 * skill 加载器。
 *
 * 扫描 skills/public 与 skills/custom 下各 SKILL.md，解析 frontmatter，
 * 合并 extensions_config.json 中的 enabled 状态，按 name 去重、按 name 排序。
 *
 * 缓存：解析结果按各分类目录 mtime 签名缓存（避免每轮 prompt 构建都遍历磁盘）；
 * enabled 状态每次从 configStore 实时合并（configStore 自身有 mtime 缓存）。
 *
 * enabled 默认值：本项目为 Prompt 注入式，启用即把 skill 正文注入系统提示，
 * 有 token 预算成本，因此默认 **禁用（opt-in）**——与 deer-flow 沙箱场景的
 * 默认启用不同，由用户在设置界面按需开启。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getExtensionsConfigStore } from '../extensions';
import { getCustomSkillsDir, getPublicSkillsDir, getSkillsRootDir } from '../extensions/paths';
import { parseFrontmatter } from './frontmatter';
import { type Skill, type SkillCategory, validateSkillName } from './types';

interface ParsedSkill {
  name: string;
  description: string;
  license: string | null;
  body: string;
  category: SkillCategory;
  relativePath: string;
  dir: string;
}

interface ParsedCache {
  skills: ParsedSkill[];
  signature: string;
}

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
): Promise<ParsedSkill | null> {
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

  return { name, description, license, body: parsed.body, category, relativePath, dir };
}

async function loadParsedSkills(): Promise<ParsedSkill[]> {
  const publicDir = getPublicSkillsDir();
  const customDir = getCustomSkillsDir();
  const signature = JSON.stringify([await dirMtimeMs(publicDir), await dirMtimeMs(customDir)]);

  if (_parsedCache && _parsedCache.signature === signature) {
    return _parsedCache.skills;
  }

  const byName = new Map<string, ParsedSkill>();
  for (const category of ['public', 'custom'] as const) {
    const categoryRoot = category === 'public' ? publicDir : customDir;
    const files = await findSkillFiles(categoryRoot);
    for (const file of files) {
      const skill = await parseSkillFile(file, category, categoryRoot);
      if (skill) byName.set(skill.name, skill);
    }
  }

  const skills = [...byName.values()];
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
 * 启用技能名的稳定签名（排序后 JSON）。
 * 供 agent 实例缓存键使用：启用集变化时触发 agent 重建。
 */
export async function getEnabledSkillsSignature(): Promise<string> {
  const skills = await loadEnabledSkills();
  return JSON.stringify(skills.map((s) => s.name).sort());
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
  };
}

export function getSkillsRoot(): string {
  return getSkillsRootDir();
}
