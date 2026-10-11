/**
 * skill 子系统公共 API barrel。
 */

export {
  type Skill,
  type SkillCategory,
  type SkillResource,
  type SkillResourceKind,
  SKILL_NAME_PATTERN,
  validateSkillName,
} from './types';

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
  enumerateResources,
  extractResourceSummary,
} from './loader';

export { buildSkillsSection } from './prompt';
