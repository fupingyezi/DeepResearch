/**
 * skill 子系统公共 API barrel。
 */

export { type Skill, type SkillCategory, SKILL_NAME_PATTERN, validateSkillName } from './types';

export { type Frontmatter, parseFrontmatter } from './frontmatter';

export {
  type LoadSkillsOptions,
  type CreateCustomSkillInput,
  loadSkills,
  loadEnabledSkills,
  getEnabledSkillsSignature,
  resetSkillCache,
  createCustomSkill,
  getSkillsRoot,
} from './loader';

export { buildSkillsSection } from './prompt';
