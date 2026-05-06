/**
 * Skills Module — deerflow-harness
 *
 * 可复用的高级能力（预留模块）
 *
 * @module deerflow-harness/skills
 */

/**
 * Skill 接口
 *
 * 未来实现时，Skill 将封装可复用的高级能力（如搜索、总结、翻译等），
 * 可被多个 Agent 共享使用。
 */
export interface Skill {
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description: string;
  /** 执行技能 */
  execute(input: Record<string, unknown>): Promise<SkillResult>;
}

/** Skill 执行结果 */
export interface SkillResult {
  success: boolean;
  output: string;
  metadata?: Record<string, unknown>;
}
