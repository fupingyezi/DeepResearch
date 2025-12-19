import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { TavilySearchAPIRetriever } from "@langchain/community/retrievers/tavily_search_api";
import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  createAgent,
  tool,
} from "langchain";
// import { taskType } from "@/types";
import { getCheckpointer } from "@/lib";
import z from "zod";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

type workflowNode =
  | "supervisor"
  | "outlinePlanner"
  | "outlineHandler"
  | "reportGenerationAssistant"
  | "taskDecomposer"
  | "taskHandler"
  | "summaryAssistant"
  | "__end__";

export interface taskType {
  id: string;
  description: string;
  status: "pending" | "searched" | "failed_attempt" | "processed";
  searchResult?: string[];
  result?: string[];
  feedback: string;
}

const StateAnnotation = Annotation.Root({
  originalQuery: Annotation<string>(), //input
  outline: Annotation<string[]>(), //大纲
  currentOutlineIndex: Annotation<number>(), //当前步骤
  currentTasks: Annotation<taskType[]>(), //当前步骤需要完成的任务
  completedTasks: Annotation<{ [taskId: string]: string }>(), //已完成的任务信息
  searchResult: Annotation<string[]>(), //搜索结果
  accumulatedKnowledge: Annotation<string>(), // 已完成任务信息整理
  nextNode: Annotation<workflowNode>(),
  reflection: Annotation<string>(), // 反思决策
  isComplete: Annotation<boolean>(), // 结束信号
});

export async function supervisor(state: typeof StateAnnotation.State) {
  const model = new ChatOpenAI({
    model: "qwen-max",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: { baseURL: process.env.OPENAI_QWEN_BASE_URL },
    temperature: 0,
    maxTokens: 2000,
  });

  const systemPrompt = `
  你是一个多智能体深度研究系统的总协调者（Supervisor），职责是根据当前任务进度，决定下一步应调用哪个子 Agent。

  每次调用时，系统会提供一个包含完整任务进度的 message。请严格依据该信息进行判断。

  可调用的子 Agent 及触发条件：
  1. outlinePlanner
    功能：根据用户的原始输入生成研究大纲。  
    调用时机：任务刚开始，且当前进度中尚未生成大纲。

  2. outlineHandler
    功能：逐项执行并完成大纲中的各个研究步骤。
    调用时机：大纲已存在，但仍有未完成的步骤。

  3. reportGenerationAssistant
    功能：基于已完成的研究内容生成最终报告。
    调用时机：大纲中所有步骤均已标记为完成。

    输出规则：
    仅输出一个 JSON 对象，格式为：{ "decision": "子Agent名称" }
    若所有任务已完成且报告已生成，则输出：{ "decision": "__end__" }
    禁止输出任何其他文本、解释或格式。
  `;

  const supervisorAgent = createAgent({
    model: model,
    systemPrompt: systemPrompt,
  });

  const outlineInfo = (): string => {
    if (!state.outline.length) {
      return "无";
    }
    let text = "";
    for (const step of state.outline) {
      text += `${step}\n`;
    }

    return text;
  };

  const tasksInfo = (): string => {
    if (!state.currentTasks.length) {
      return "";
    } else {
      let taskText = "";
      for (const task of state.currentTasks) {
        taskText += `taskId: ${task.id}, taskDescription: ${task.description} \n`;
      }
      return taskText;
    }
  };

  const currentStateMessages = `
  当前系统任务状态：
    用户原始问题：${state.originalQuery}。

    大纲：
      ${outlineInfo()}。

    当前处理的大纲步骤：第${state.currentOutlineIndex}步-${
    state.outline[state.currentOutlineIndex]
  }
    报告是否已经完成：${state.isComplete}
    
  请给出下一步决策。
  `;

  console.log("currentState:", currentStateMessages);

  const response = await supervisorAgent.invoke({
    messages: currentStateMessages,
  });
  const messages = response.messages;
  console.log("decision messages:", messages);
  const nextDecision = messages[messages.length - 1].content as string;

  const decisionMatch = nextDecision.match(/\{[^{}]*\}/);
  if (decisionMatch) {
    try {
      const jsonString = decisionMatch[0].replace(
        /([{,]\s*)(\w+)(\s*:)/g,
        '$1"$2"$3'
      );
      const parsed = JSON.parse(jsonString);
      state.nextNode = parsed.decision;
    } catch (e) {
      console.error("Failed to parse decision JSON:", e);
      state.nextNode = "__end__";
    }
  } else {
    console.error("No JSON object found in LLM response:", nextDecision);
    state.nextNode = "__end__";
  }
}

export async function outlinePlanner(state: typeof StateAnnotation.State) {
  const model = new ChatOpenAI({
    model: "qwen-max",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: { baseURL: process.env.OPENAI_QWEN_BASE_URL },
    temperature: 0.3,
    maxTokens: 200,
  });

  const systemPrompt = `
  你是一个深度研究助手的大纲助手，负责分析用户的原始输入并生成循序渐进的研究大纲
  `;
  const response = await model.invoke([
    { role: "system", content: systemPrompt },
    { role: "human", content: state.originalQuery },
  ]);

  console.log(response);
}

export async function outlineHandler(state: typeof StateAnnotation.State) {
  const model = new ChatOpenAI({
    model: "qwen-max",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: { baseURL: process.env.OPENAI_QWEN_BASE_URL },
    temperature: 0.3,
    maxTokens: 200,
  });

  const systemPrompt = `
  你是一个多智能体深度研究助手的子协调者(subSupervisor)，负责处理研究大纲的具体工作，根据当前系统和大纲的状态决定下一步执行的智能体

  任务进度获取：
    在每次调用时，系统会传入给你代表整个系统任务进和当前大纲进度的message。
  
  你可以调用的子agent、功能以及对应需要调用时的情况如下：
    1. taskDecomposer：在大纲对应步骤中细化步骤任务的任务拆解助手，在大纲已经生成后，如果当前大纲还没有生成子任务时调用或者当前子任务执行完毕后还缺少信息时执行。
    2. taskHandleer: 负责解决每个子任务
    3. summaryAssitant：信息总结助手，在大纲每一步结束之后总结已获取的全部信息，在大纲中对应步骤刚结束时调用。

  调用原则
    你只能调用这些列出的子Agent，且无需关注子Agent具体是如何运行的，只需根据功能以及调用时机调用对应子Agent即可。
    在调用时只需返回JSON格式{ "decision": "对应的子agent名称"，如"taskDecomposer" }
    如果所有任务都已完成且已生成报告，返回{ "decision": "supervisor" }，不返回其他内容
  `;

  const subSupervisor = createAgent({
    model: model,
    systemPrompt: systemPrompt,
  });

  const currentStateMessages = `
  当前系统任务状态：
    用户原始问题：${state.originalQuery}。
    之前已获取的信息：${state.accumulatedKnowledge}

    当前处理的大纲：第${state.currentOutlineIndex}步-${
    state.outline[state.currentOutlineIndex]
  }
    当前步骤是否已经完成：${state.isComplete}
    
  请给出下一步决策。
  `;
}

async function reportGenerationAssitant(state: typeof StateAnnotation.State) {
  const model = new ChatOpenAI({
    model: "qwen-flash",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: { baseURL: process.env.OPENAI_QWEN_BASE_URL },
    temperature: 0.3,
    maxTokens: 200,
  });
  const systemPrompt = `
  你是一个多智能体深度研究助手的报告生成助手，负责将所有已收集并处理的信息，根据用户原始问题和大纲生成最后的研究报告
  `;
}
async function taskDecomposer(state: typeof StateAnnotation.State) {
  const model = new ChatOpenAI({
    model: "qwen-max",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: {
      baseURL: process.env.OPENAI_QWEN_BASE_URL,
    },
    maxTokens: 2000,
    temperature: 0.3,
  });

  const systemPrompt = `你是一个负责将大纲当前步骤所缺少的信息拆解成子任务的任务拆解助手。
                        具体职责为将用户的输入拆解后以
                        JSON:{ task: [{ id: string, description: string }] }格式返回，
                        各属性分别代表task的标识id，任务的描述和该任务是否需要进行网络web搜索查询信息`;
}

export async function taskHanlder(state: typeof StateAnnotation.State) {
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

  const model = new ChatOpenAI({
    model: "qwen-flash",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: { baseURL: process.env.OPENAI_QWEN_BASE_URL },
    temperature: 0.3,
    maxTokens: 200,
  }).bindTools([searchWebTool]);

  const systemPrompt = `
  你是一个多智能体深度研究助手的任务处理助手，负责处理上级agent拆解出的具体任务。

  处理过程：
  1. 判断该任务是否需要网络搜索。
  2. 如果需要，先进行网络搜索再进行处理；如果不需要，直接进行处理。

  你进行网络搜索时必须调用工具search_web_tool
  `;
}

export async function summaryAssitant(state: typeof StateAnnotation.State) {
  const model = new ChatOpenAI({
    model: "qwen-flash",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: { baseURL: process.env.OPENAI_QWEN_BASE_URL },
    temperature: 0.3,
    maxTokens: 200,
  });

  const systemPrompt = `
  你是一个多智能体深度研究助手的总结助手，负责总结当前步骤处理后还未总结的信息。
  `;
}

async function createDeepResearchWorkflow() {
  const checkpointer = await getCheckpointer();
  const workflow = new StateGraph(StateAnnotation)
    .addNode("supervisor", supervisor)
    .addNode("taskDecomposer", taskDecomposer)
    .addNode("taskHandler", taskHanlder)
    .addNode("outlinePlanner", outlinePlanner)
    .addNode("outlineHandler", outlineHandler)
    .addNode("reportGenerationAssitant", reportGenerationAssitant)
    .addNode("summaryAssitant", summaryAssitant)

    .addEdge(START, "supervisor")

    .addConditionalEdges("supervisor", (state) => state.nextNode, {
      outlinePlanner: "outlinePlanner",
      outlineHandler: "outlineHandler",
      reportGenerationAssitant: "reportGenerationAssitant",
      __end__: END,
    })

    .addEdge("outlinePlanner", "supervisor")
    .addEdge("outlineHandler", "supervisor")
    .addEdge("reportGenerationAssitant", "supervisor")

    .addConditionalEdges("outlineHandler", (state) => state.nextNode, {
      taskDecomposer: "taskDecomposer",
      taskHanlder: "taskHandler",
      summaryAssitant: "summaryAssitant",
      supervisor: "supervisor",
    })

    .addEdge("taskDecomposer", "outlineHandler")
    .addEdge("taskHandler", "outlineHandler")
    .addEdge("summaryAssitant", "outlineHandler")

    .compile({ checkpointer });

  return workflow;
}

export { createDeepResearchWorkflow };
