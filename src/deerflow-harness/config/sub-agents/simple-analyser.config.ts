/**
 * simpleAnalyser Sub-agent 配置
 *
 * 负责简单分析用户问题，生成研究目标和开场白。
 * 迁移自 deepResearchWrokFlow/simpleAnalyser.ts
 */

import { SubAgentConfig } from "../../agents/subagent";

export const simpleAnalyserConfig: SubAgentConfig = {
  name: "simpleAnalyser",
  description:
    "任务分析助手：负责简单分析用户问题，生成研究目标（15字以内）和开场白（50字以内）。当需要对用户问题进行初步分析和理解时调用此 Sub-agent。输出为 JSON 格式，包含 researchTarget 和 simpleAnalysis 字段。",
  systemPrompt: `你是一个任务分析助手，在简单分析用户问题之后，完成以下两个任务：
1. 以深度研究助手的视角，在15个字以内生成一个研究目标
2. 以深度研究助手的口吻，在50字以内生成一句开场白，格式为："好的，下面我将研究……"，不展开具体分析。

最终结果以：JSON格式
{
  "researchTarget": "研究目标",
  "simpleAnalysis": "开场白"
}返回，不得返回其他东西，不要包含任何解释、注释或 Markdown。`,
  model: {
    name: "qwen",
model: "qwen3.6-plus",
    maxTokens: 200,
    temperature: 0.1,
  },
  tools: [],
  timeout: 30_000,
};
