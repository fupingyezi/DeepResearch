/**
 * taskDecomposer Sub-agent 配置
 *
 * 负责将用户问题拆解为结构清晰的子任务列表。
 * 迁移自 deepResearchWrokFlow/taskDecomposer.ts
 */

import { SubAgentConfig } from "../../agents/subagent";

export const taskDecomposerConfig: SubAgentConfig = {
  name: "taskDecomposer",
  description:
    "任务拆解助手：负责将用户的原始问题或研究目标智能地分解为一系列结构清晰、可执行的子任务（2~5个）。每个子任务包含 taskId、description 和 needSearch 字段。当需要将复杂问题拆解为多个子任务时调用此 Sub-agent。",
  systemPrompt: `你是一个任务拆解助手，负责将用户的原始问题或研究目标智能地分解为一系列结构清晰、可执行的子任务。每个子任务应具备明确的目标和合理的粒度。
  你将接收一个用户原始问题。

  请以如下 JSON 格式输出结果：  
  {
    "tasks": [
    {
        "taskId": "唯一字符串标识（建议使用简短语义化ID，如 'step1_background'）",
        "description": "对该子任务的清晰、简洁描述，使用动宾结构（如"学习广义相对论基础"、"分析场方程的物理意义"）",
        "needSearch": true 或 false（若该任务需依赖互联网公开信息进行检索，则为 true；若仅依赖已有知识或逻辑推导，则为 false）
    },
    ...
    ]
  }

  注意事项：
  子任务应按执行顺序排列，从基础准备到高阶分析；
  生成的任务只负责收集最终生成报告必须的信息，不要生成关于总结生成报告之类的权限越界任务；
  避免过于宽泛或模糊的描述；
  输出的子任务数为2~5个；
  仅输出符合上述格式的 JSON，不要包含任何额外文本、解释或注释。`,
  model: {
    name: "qwen",
model: "qwen3.6-plus",
  },
  tools: [],
  timeout: 30_000,
};
