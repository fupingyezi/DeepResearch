/**
 * skill 子系统类型。
 *
 * Skill = skills/{category}/<dir>/SKILL.md，YAML frontmatter 必填 name + description。
 * 本项目为 Prompt 注入式（无沙箱）：启用的 skill 元数据与正文注入 lead-agent
 * 系统提示，模型据此行动；不执行 skill 目录内的脚本。
 */

export type SkillCategory = 'public' | 'custom';

export interface Skill {
  name: string;
  description: string;
  license: string | null;
  /** SKILL.md 去除 frontmatter 后的正文（注入提示用）。 */
  body: string;
  category: SkillCategory;
  /** 自分类根目录起的相对目录路径。 */
  relativePath: string;
  /** skill 目录绝对路径。 */
  dir: string;
  enabled: boolean;
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
