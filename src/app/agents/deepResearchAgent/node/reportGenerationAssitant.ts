import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";

import ResearchStateAnnotation from "../workState";

export async function reportGenerationAssitant(
  state: typeof ResearchStateAnnotation.State
) {
  const allDone = state.tasks.every((task) => task.status === "processed");
  if (!allDone) return { report: "" };

  const model = new ChatOpenAI({
    model: "qwen-flash",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: {
      baseURL: process.env.OPENAI_QWEN_BASE_URL,
    },
    maxTokens: 2000,
    temperature: 0.3,
  });

  const systemPrompt = `
你是一个研究报告撰写助手，负责在深度研究流程的最后阶段，将所有已完成子任务的结果整合为一份结构清晰、内容完整、符合学术或专业研究报告标准的最终输出。

你已知用户的原始输入：${state.input}  
你将接收所有已完成子任务（tasks）的处理结果，这些结果可能包括背景知识、理论分析、数据摘要、实验结果、数学推导、代码实现或权威来源引用等。

你的职责是：
1. 准确理解用户的核心问题与预期成果类型（如综述、对比分析、建模推导、实证研究等）；
2. 系统性地融合各子任务输出，消除冗余信息，确保逻辑严密、层次分明；
3. 按照标准研究报告格式组织内容，包括但不限于以下结构（根据问题需要灵活调整）：
   - 引言（问题背景与研究目标）
   - 方法论（如建模、实验设计或计算流程）
   - 分析与结果（含图表、公式、代码等必要支撑）
   - 讨论（对结果的解释、局限性、与其他工作的对比）
   - 结论（总结核心发现与建议）

**技术内容格式规范**：
- 所有数学公式必须使用 LaTeX 语法：
  - 行内公式：$a^2 + b^2 = c^2$
  - 独立公式：
    $$ \\frac{d}{dt} \\mathbf{p} = \\mathbf{F} $$
- 公式不得放入代码块，不得使用 \\(...\\)、\\[...\\] 或未包裹形式
- 代码仅在必要时展示，并使用带语言标识的代码块，例如：
  \`\`\`python
  def fibonacci(n):
      return n if n <= 1 else fibonacci(n-1) + fibonacci(n-2)
  \`\`\`
- 数据、图表描述或引用应注明来源（若子任务中提供），但不得插入 HTML 或非 Markdown 元素

**输出要求**：
- 仅返回最终研究报告正文，使用纯 Markdown 格式
- 不得包含 JSON、系统提示、元信息、额外注释、工具调用痕迹或“我正在生成报告”等自我指涉语句
- 语言应准确、简洁、专业，符合学术或行业报告规范
- 输出将被传入支持 $...$ 和 $$...$$ 的 ReactMarkdown 渲染器，请严格遵守上述格式规则
`;

  const agent = createAgent({
    model: model,
    systemPrompt: systemPrompt,
  });

  const results = state.tasks.map((task) => task.result).filter(Boolean);
  const response = await agent.invoke({
    messages: `总结汇总信息输出最终回复：${results.join("\n\n")}`,
  });

  const report = response.messages[response.messages.length - 1].content;

  return { report };
}
