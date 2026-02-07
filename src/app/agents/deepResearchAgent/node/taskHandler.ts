import { createAgent } from "langchain";
import { buildLLM } from "@/lib/llm";
import { searchWebTool } from "../../tools";
import ResearchStateAnnotation from "../workState";
import { parseSearchResult } from "@/utils/handleStateUpdate";

export async function taskHandler(state: typeof ResearchStateAnnotation.State) {
  let tasksWaitProcess;
  for (const task of state.tasks) {
    if (task.status === "pending") {
      tasksWaitProcess = task;
      break;
    }
  }
  if (!tasksWaitProcess) return { tasks: [] };

  const model = buildLLM("qwen", { model: "qwen-flash" }).bindTools([
    searchWebTool,
  ]);

  const systemPrompt = `
你是一个深度研究系统中的信息处理助手，采用 ReAct（Reasoning + Acting）推理模式。你的核心职责是：针对当前分配的子任务（task）进行分析与执行。

输入包含：
- 用户原始问题：${state.input}
- 当前任务描述：来自任务拆解结果中的 description
- 若该任务标记为 needSearch: true 且已被执行，则还会提供通过 search_web_tool 获取的网络搜索结果

你的处理逻辑应遵循以下原则：
1. **先推理（Reason）**：准确理解任务目标，判断所需信息是否已由上下文（context）充分提供。
2. **再行动（Act）**：若需搜索且尚未调用工具，应主动调用 search_web_tool；但在此阶段，通常 context 已包含搜索结果，你只需基于其进行整合。
3. **输出结果**：返回经过筛选、归纳、结构化整理的信息，内容应紧扣任务描述，语言简洁准确，避免冗余或无关细节。

**输出格式规范**：
- 所有数学公式必须使用 LaTeX 语法：
  - 行内公式用单美元符号包裹，例如：$E = mc^2$
  - 独立公式必须用双美元符号包裹，前后换行，例如：
    $$ \\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0} $$
- 不得将公式放入代码块（即禁止使用 \`\`\`、\`\`\`math、\`\`\`latex 等）
- 仅在确实需要展示可执行代码时，才使用三个反引号包裹，并明确标注语言（如 \`\`\`python）
- 禁止使用 HTML 标签、非标准公式语法（如 \\(...\\)、\\[...\\]）或未包裹的 LaTeX 表达式
- 输出必须为纯 Markdown 文本，不含 JSON、元数据、工具调用指令、解释性语句或自我指涉内容

最终输出仅为处理后的文本结果，适配支持 $...$ 和 $$...$$ 的 ReactMarkdown 渲染器。
`;

  const agent = createAgent({
    model: model,
    systemPrompt: systemPrompt,
    tools: [searchWebTool],
  });

  const context = tasksWaitProcess.searchResult || "";
  const response = await agent.invoke({
    messages: `Process task: ${tasksWaitProcess.description} Context: ${context}`,
  });
  const messages = response.messages;
  const finalResult = messages[messages.length - 1].content;
  // console.log("message", messages);
  const toolMessage = messages.find((msg) => msg._getType() === "tool");
  // console.log("toolMessage", toolMessage);
  const updatedTasks = state.tasks.map((t) =>
    t.taskId === tasksWaitProcess.taskId
      ? {
          ...t,
          status: "processed",
          result: finalResult,
          searchResult:
            parseSearchResult(
              toolMessage ? (toolMessage?.content as string) : "",
            ) || [],
        }
      : t,
  );

  return {
    tasks: updatedTasks,
    curAction: "taskHandle",
  };
}
