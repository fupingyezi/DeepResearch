/**
 * skill 子系统类型。
 *
 * Skill = skills/{category}/<dir>/SKILL.md，YAML frontmatter 必填 name + description，
 * 可选 references/（只读知识）与 scripts/（可执行脚本）。
 * 渐进披露三层：L1 系统提示只注入 name/description/资源目录；L2 SKILL.md 正文与
 * L3 references/scripts 由模型按需经 `skill` 工具读取（scripts 可 action=run 沙箱执行）。
 */

export type SkillCategory = 'public' | 'custom';

export type SkillResourceKind = 'reference' | 'script';

export interface SkillResource {
  /** 相对 skill 目录的 POSIX 路径，如 `references/phase1.md`、`scripts/fetch.py`。 */
  path: string;
  /** 单行摘要：文件首个 markdown 标题，或首个非空行（截断 ~120 字符）。 */
  summary: string;
  kind: SkillResourceKind;
}

export interface Skill {
  name: string;
  description: string;
  license: string | null;
  /** SKILL.md 去除 frontmatter 后的正文（经 skill 工具按需读取，不注入提示）。 */
  body: string;
  category: SkillCategory;
  /** 自分类根目录起的相对目录路径。 */
  relativePath: string;
  /** skill 目录绝对路径。 */
  dir: string;
  enabled: boolean;
  /** references/ 与 scripts/ 下的资源清单（按路径排序，每 skill 上限 50 个）。 */
  resources: SkillResource[];
  /** SKILL.md 正文的单行摘要（资源目录展示用）。 */
  summary: string;
}

/** 自定义 skill 名校验：小写字母/数字 + 连字符，≤64。 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateSkillName(name: string): string {
  const normalized = name.trim();
  if (!SKILL_NAME_PATTERN.test(normalized)) {
    throw new Error(
      'Skill name must be hyphen-case using lowercase letters, digits, and hyphens only.',
    );
  }
  if (normalized.length > 64) {
    throw new Error('Skill name must be 64 characters or fewer.');
  }
  return normalized;
}
