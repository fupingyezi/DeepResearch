/**
 * 启用技能（Skill）的系统提示注入。
 *
 * 本项目无沙箱，模型无法按需读取 SKILL.md，故把启用 skill 的名称、描述与正文
 * 一并注入系统提示，模型据此判断何时遵循对应 skill 的工作流。
 */

import type { Skill } from './types';

/**
 * 构建 <available_skills> 注入块；无启用 skill 时返回空字符串。
 */
export function buildSkillsSection(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const blocks = skills
    .map((skill) => {
      const body = skill.body ? `\n\n${skill.body}` : '';
      return `## ${skill.name}\n${skill.description}${body}`;
    })
    .join('\n\n');

  return `<available_skills>
你已具备以下技能（Skill）。当用户的需求与某个技能的用途相符时，遵循该技能描述的工作流来完成任务；不相符时正常作答，不要强行套用。

${blocks}
</available_skills>`;
}
