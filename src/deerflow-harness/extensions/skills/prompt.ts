/**
 * 启用技能（Skill）的系统提示注入（L1 渐进披露）。
 *
 * 只注入 name / description / 资源目录（路径 + 单行摘要），**不注入正文**——
 * 正文与 references/scripts 由模型按需经 `skill` 工具读取（L2/L3），
 * scripts 可用 action=run 在沙箱工作区执行。启用集再大也只吃目录级 token。
 */

import type { Skill } from './types';

/**
 * 构建 <available_skills> 注入块；无启用 skill 时返回空字符串。
 */
export function buildSkillsSection(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const blocks = skills.map((skill) => {
    const resourceLines = [
      skill.summary ? `- SKILL.md：${skill.summary}` : '- SKILL.md',
      ...skill.resources.map((r) => {
        const suffix = r.kind === 'script' ? '（脚本，可在沙箱中执行）' : '';
        return r.summary ? `- ${r.path}：${r.summary}${suffix}` : `- ${r.path}${suffix}`;
      }),
    ];
    return `## ${skill.name}
${skill.description}

资源目录：
${resourceLines.join('\n')}`;
  });

  return `<available_skills>
你已具备以下技能（Skill）。当用户需求与某个技能的用途相符时，调用 \`skill\` 工具读取该技能的资源并遵循其工作流完成任务；不相符时正常作答，不要强行套用。

技能的正文、参考资料与脚本**不会**自动注入上下文，需要时按需读取：
- \`skill(skill="<技能名>")\` → 返回该技能 SKILL.md 正文（工作流主说明）
- \`skill(skill="<技能名>", resource="references/xxx.md")\` → 返回指定参考文件
- \`skill(skill="<技能名>", action="run", resource="scripts/xxx.py", args="...")\` → 在沙箱工作区执行脚本并返回输出

${blocks.join('\n\n')}
</available_skills>`;
}
