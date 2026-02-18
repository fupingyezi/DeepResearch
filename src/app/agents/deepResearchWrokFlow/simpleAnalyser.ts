import { createAgent } from "langchain";
import { buildLLM } from "@/lib/llm";
import ResearchStateAnnotation from "./workState";

export async function simpleAnalyser(
  state: typeof ResearchStateAnnotation.State,
) {
  const model = buildLLM("qwen", {
    model: "qwen-flash",
    maxTokens: 200,
    temperature: 0.1,
  });

  const systemPrompt = `
你是一个任务分析助手，在简单分析用户问题之后，完成以下两个任务：
1. 以深度研究助手的视角，在15个字以内生成一个研究目标
2. 以深度研究助手的口吻，在50字以内生成一句开场白，格式为：“好的，下面我将研究……”，不展开具体分析。

最终结果以：JSON格式
{
  "researchTarget": "研究目标",
  "simpleAnalysis": "开场白"
}返回，不得返回其他东西，不要包含任何解释、注释或 Markdown。

用户问题:
${state.input}
`;

  const agent = createAgent({
    model: model,
    systemPrompt: systemPrompt,
  });

  const response = await agent.invoke({
    messages: "请输出符合要求的JSON。",
  });

  const rawContent = response.messages[response.messages.length - 1].content;

  try {
    const result = JSON.parse(rawContent as string);

    return {
      researchTarget: result.researchTarget.trim(),
      simpleAnalysis: result.simpleAnalysis.trim(),
      curAction: "simpleAnalyse",
    };
  } catch (error) {
    console.error("Failed to parse LLM response as JSON:", rawContent);
    throw new Error(`LLM did not return valid JSON: ${rawContent}`);
  }
}
