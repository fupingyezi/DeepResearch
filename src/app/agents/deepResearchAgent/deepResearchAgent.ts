import z from "zod";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { createAgent, tool, BaseMessage } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { TavilySearchAPIRetriever } from "@langchain/community/retrievers/tavily_search_api";
import type { taskType } from "@/types";
import { getCheckpointer } from "@/lib";
import { parseSearchResult } from "@/utils/handleStateUpdate";

import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const searchWebTool = tool(
  async (input) => {
    const tavy = new TavilySearchAPIRetriever({
      apiKey: process.env.TAVILY_API_KEY,
    });
    const response = await tavy.invoke(input.question);
    const relatedWebInfo = response
      .map((doc, index) => {
        return `结果 ${index + 1}:
        标题: ${doc.metadata.title}
        来源: ${doc.metadata.source}    
        内容: ${doc.pageContent}
        相关性评分: ${doc.metadata.score}
        ---`;
      })
      .join("\n");
    return relatedWebInfo;
  },
  {
    name: "search_web_tool",
    description: "执行任务搜索功能",
    schema: z.object({
      question: z.string(),
    }),
  }
);

const StateAnnotation = Annotation.Root({
  input: Annotation<string>(),
  researchTarget: Annotation<string>(),
  simpleAnalysis: Annotation<string>(),
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
  }),
  tasks: Annotation<taskType[]>({
    reducer: (old, update) => {
      const map = new Map((old || []).map((t) => [t.taskId, t]));
      for (const t of update || []) {
        map.set(t.taskId, { ...map.get(t.taskId), ...t });
      }
      return Array.from(map.values());
    },
  }),
  nextAction: Annotation<string>(),
  summary: Annotation<string>(),
});

async function supervisor(state: typeof StateAnnotation.State) {
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
${state.summary ? "是" : "否"}

请严格根据以下规则依次判断并选择下一步，并仅输出一个 JSON 对象，不要包含任何其他文字、解释或 Markdown：

- 如果还没有简单的分析 → 输出 {"next": "analyse"}
- 如果还没有任务列表 → 输出 {"next": "taskDecomposer"}
- 如果有 pending 的任务 → 输出 {"next": "process"}
- 如果所有任务都 processed 但 summary 为空 → 输出 {"next": "summarize"}
- 如果 summary 已生成 → 输出 {"next": "end"}

合法的 next 值只有：analyse, taskDecomposer, process, summarize, end
`;

  // console.log("当前状态：\n", systemPrompt);

  // const supervisorAgent = createAgent({
  //   model: model,
  //   systemPrompt: systemPrompt,
  // });

  const response = await model.invoke([
    { role: "system", content: systemPrompt },
    { role: "human", content: "请做出决策。" },
  ]);
  const message = response.content;
  const content = (message as string).trim();

  // console.log("Supervisor raw output:", content);

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
    analyse: "simpleAnalyse",
    taskDecomposer: "taskDecomposer",
    process: "taskHandler",
    summarize: "reportGenerationAssitant",
    end: "__end__",
  };

  const nextAction = nodeMap[next] ?? "__end__";
  console.log("Supervisor 决策:", { next, nextAction });

  return { nextAction };
}

async function simpleAnalyse(state: typeof StateAnnotation.State) {
  const model = new ChatOpenAI({
    model: "qwen-flash",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: {
      baseURL: process.env.OPENAI_QWEN_BASE_URL,
    },
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
  // console.log("row simpleAnalysis result:", rawContent);

  try {
    const result = JSON.parse(rawContent as string);
    // console.log("parse result:", result);

    return {
      researchTarget: result.researchTarget.trim(),
      simpleAnalysis: result.simpleAnalysis.trim(),
    };
  } catch (error) {
    console.error("Failed to parse LLM response as JSON:", rawContent);
    throw new Error(`LLM did not return valid JSON: ${rawContent}`);
  }
}

// 任务拆解子agent
async function taskDecomposer(state: typeof StateAnnotation.State) {
  const model = new ChatOpenAI({
    model: "qwen-flash",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: {
      baseURL: process.env.OPENAI_QWEN_BASE_URL,
    },
    maxTokens: 2000,
    temperature: 0.3,
  });

  const systemPrompt = `你是一个任务拆解助手，负责将用户的原始问题或研究目标智能地分解为一系列结构清晰、可执行的子任务。每个子任务应具备明确的目标和合理的粒度。
  你将接收一个用户原始问题。

  请以如下 JSON 格式输出结果：  
  {
    "tasks": [
    {
        "taskId": "唯一字符串标识（建议使用简短语义化ID，如 'step1_background'）",
        "description": "对该子任务的清晰、简洁描述，使用动宾结构（如“学习广义相对论基础”、“分析场方程的物理意义”）",
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
  仅输出符合上述格式的 JSON，不要包含任何额外文本、解释或注释。`;

  const agent = createAgent({
    model: model,
    systemPrompt: systemPrompt,
  });

  const response = await agent.invoke({ messages: state.input });
  const messages = response.messages;
  const lastMessages = messages[messages.length - 1];

  const content = lastMessages.content as string;

  let parsedData = null;
  try {
    parsedData = JSON.parse(content.trim());
  } catch (e) {
    console.error("Failed to parse JSON from model response:", content);
    return { tasks: [] };
  }

  if (parsedData && Array.isArray(parsedData.tasks)) {
    const tasks: taskType[] = parsedData.tasks.map(
      (task: { taskId: string; description: string; needSearch: boolean }) => ({
        ...task,
        status: "pending",
        result: "",
        searchResult: [],
      })
    );
    // console.log("解析的任务:", tasks);
    return { tasks };
  } else {
    console.error("解析结果中缺少有效的 tasks 数组", parsedData);
    return { tasks: [] };
  }
}

async function taskHandler(state: typeof StateAnnotation.State) {
  let tasksWaitProcess;
  for (const task of state.tasks) {
    if (task.status === "pending") {
      tasksWaitProcess = task;
      break;
    }
  }
  if (!tasksWaitProcess) return { tasks: [] };
  const model = new ChatOpenAI({
    model: "qwen-flash",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: {
      baseURL: process.env.OPENAI_QWEN_BASE_URL,
    },
    maxTokens: 2000,
    temperature: 0.3,
  }).bindTools([searchWebTool]);

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

  return {
    tasks: [
      {
        ...tasksWaitProcess,
        status: "processed",
        result: finalResult,
        searchResult:
          parseSearchResult(
            toolMessage ? (toolMessage?.content as string) : ""
          ) || [],
      },
    ],
  };
}

async function reportGenerationAssitant(state: typeof StateAnnotation.State) {
  const allDone = state.tasks.every((task) => task.status === "processed");
  if (!allDone) return { summary: "" };

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

  const summary = response.messages[response.messages.length - 1].content;

  return { summary };
}

async function createDeepResearchWorkflow() {
  const checkpointer = await getCheckpointer();
  const workflow = new StateGraph(StateAnnotation)
    .addNode("supervisor", supervisor)
    .addNode("simpleAnalyse", simpleAnalyse)
    .addNode("taskDecomposer", taskDecomposer)
    .addNode("taskHandler", taskHandler)
    .addNode("reportGenerationAssitant", reportGenerationAssitant)

    .addEdge(START, "supervisor")

    .addConditionalEdges("supervisor", (state) => state.nextAction, {
      simpleAnalyse: "simpleAnalyse",
      taskDecomposer: "taskDecomposer",
      taskHandler: "taskHandler",
      reportGenerationAssitant: "reportGenerationAssitant",
      __end__: END,
    })

    .addEdge("simpleAnalyse", "supervisor")
    .addEdge("taskDecomposer", "supervisor")
    .addEdge("taskHandler", "supervisor")
    .addEdge("reportGenerationAssitant", "supervisor")

    .compile({ checkpointer });

  return workflow;
}

export { createDeepResearchWorkflow };
