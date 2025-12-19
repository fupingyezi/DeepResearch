import { ChatOpenAI } from "@langchain/openai";

import ResearchStateAnnotation from "../workState";

export async function supervisor(state: typeof ResearchStateAnnotation.State) {
  const model = new ChatOpenAI({
    model: "qwen-max",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: { baseURL: process.env.OPENAI_QWEN_BASE_URL },
    temperature: 0,
    maxTokens: 2000,
  });

  const taskStatusSummary = state.tasks
    .map(
      (task) =>
        `任务id, ${task.taskId}, 任务描述: ${task.description}, 任务状态: [${task.status}], 是否需要搜索: [${task.needSearch}]`
    )
    .join("\n");

  const systemPrompt = `
你是一个多智能体的深度研究系统的协调者（Supervisor），负责根据当前任务状态决定下一步执行哪个子 Agent。

原始用户问题：
"${state.input}"

是否进行了简单的分析：
${state.simpleAnalysis ? "是" : "否"}

当前任务状态：
${taskStatusSummary || "尚未拆解任务"}

是否已经生成报告：
${state.report ? "是" : "否"}

请严格根据以下规则依次判断并选择下一步，并仅输出一个 JSON 对象，不要包含任何其他文字、解释或 Markdown：

- 如果还没有简单的分析 → 输出 {"next": "analyse"}
- 如果还没有任务列表 → 输出 {"next": "taskDecomposer"}
- 如果有 pending 的任务 → 输出 {"next": "process"}
- 如果所有任务都 processed 但 report 为空 → 输出 {"next": "summarize"}
- 如果 report 已生成 → 输出 {"next": "end"}

合法的 next 值只有：analyse, taskDecomposer, process, summarize, end
`;

  const response = await model.invoke([
    { role: "system", content: systemPrompt },
    { role: "human", content: "请做出决策。" },
  ]);
  const message = response.content;
  const content = (message as string).trim();

  let next: string = "end";

  try {
    let jsonStr = content;

    const match = content.match(/```(?:json)?\s*({[\s\S]*?})\s*```/);
    if (match) {
      jsonStr = match[1];
    }

    const parsed = JSON.parse(jsonStr);
    next = parsed.next;
  } catch (error) {
    console.error("❌ Supervisor JSON 解析失败，使用默认 'end'。错误:", error);
    console.error("原始内容:", content);
    next = "end";
  }

  const nodeMap: Record<string, string> = {
    analyse: "simpleAnalyser",
    taskDecomposer: "taskDecomposer",
    process: "taskHandler",
    summarize: "reportGenerationAssitant",
    end: "__end__",
  };

  const nextAction = nodeMap[next] ?? "__end__";
  console.log("Supervisor 决策:", { next, nextAction });

  return { nextAction };
}
