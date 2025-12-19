import z from "zod";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { TavilySearchAPIRetriever } from "@langchain/community/retrievers/tavily_search_api";
import { BaseMessage } from "langchain";
import type { taskType } from "@/types";

import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const StateAnnotation = Annotation.Root({
  input: Annotation<string>(),
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
  }),
  tasks: Annotation<taskType[]>({
    reducer: (old, update) => {
      const map = new Map((old || []).map((t) => [t.id, t]));
      for (const t of update || []) {
        map.set(t.id, { ...map.get(t.id), ...t });
      }
      return Array.from(map.values());
    },
  }),
  nextAgent: Annotation<string>(),
  summary: Annotation<string>(),
});

// async function supervisorAgent(state: typeof StateAnnotation.State) {
//   const model = new ChatOpenAI({
//     model: "qwen-flash",
//     apiKey: process.env.OPENAI_QWEN_API_KEY,
//     configuration: { baseURL: process.env.OPENAI_QWEN_BASE_URL },
//     temperature: 0,
//     maxTokens: 200,
//   });

//   const taskStatusSummary = state.tasks
//     .map(
//       (task) =>
//         `任务描述: ${task.description}, 任务状态: [${task.status}], 是否需要搜索: [${task.needSearch}]`
//     )
//     .join("\n");

//   const prompt = `
// 你是一个多智能体系统的协调者（Supervisor），负责根据当前任务状态决定下一步执行哪个子 Agent。

// 原始用户问题：
// "${state.input}"

// 当前任务状态：
// ${taskStatusSummary || "尚未拆解任务"}

// 请严格根据以下规则选择下一步，并仅输出一个 JSON 对象，不要包含任何其他文字、解释或 Markdown：

// - 如果还没有任务列表 → 输出 {"next": "taskDecomposer"}
// - 如果有 pending 且 needSearch=true 的任务 → 输出 {"next": "search"}
// - 如果有 pending 且 needSearch=false 的任务，或有 searched 状态的任务 → 输出 {"next": "process"}
// - 如果所有任务都 processed 但 summary 为空 → 输出 {"next": "summarize"}
// - 如果 summary 已生成 → 输出 {"next": "end"}

// 合法的 next 值只有：taskDecomposer, search, process, summarize, end
// `;

//   const response = await model.invoke(prompt);
//   const content = (response.content as string).trim();

//   console.log("Supervisor raw output:", content);

//   let next: string = "end";

//   try {
//     let jsonStr = content;

//     const match = content.match(/```(?:json)?\s*({.*?})\s*```/s);
//     if (match) {
//       jsonStr = match[1];
//     }

//     const parsed = JSON.parse(jsonStr);
//     next = parsed.next;
//   } catch (error) {
//     console.error("❌ Supervisor JSON 解析失败，使用默认 'end'。错误:", error);
//     console.error("原始内容:", content);
//     next = "end";
//   }

//   const nodeMap: Record<string, string> = {
//     taskDecomposer: "taskDecomposerAgent",
//     search: "searchAgent",
//     process: "infoHandleAgent",
//     summarize: "summaryAgent",
//     end: "__end__",
//   };

//   const nextAgent = nodeMap[next] ?? "__end__";
//   console.log("Supervisor 决策:", { next, nextAgent });

//   return { nextAgent };
// }

export function supervisorAgent(state: typeof StateAnnotation.State): string {
  if (!state.tasks || !state.tasks.length) {
    return "taskDecomposerAgent";
  }

  const hasPendingNeedSearch = state.tasks.some(
    (task) => task.status === "pending" && task.needSearch
  );

  if (hasPendingNeedSearch) {
    return "searchAgent";
  }

  const hasReadyToProcess = state.tasks.some(
    (task) =>
      task.status === "searched" ||
      (task.status === "pending" && !task.needSearch)
  );

  if (hasReadyToProcess) {
    return "infoHandleAgent";
  }

  const isAllProcessed = state.tasks.every(
    (task) => task.status === "processed"
  );

  if (isAllProcessed && !state.summary) {
    return "summaryAgent";
  }

  return "__end__";
}

// 任务拆解子agent
async function taskDecomposerAgent(state: typeof StateAnnotation.State) {
  const model = new ChatOpenAI({
    model: "qwen-flash",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: {
      baseURL: process.env.OPENAI_QWEN_BASE_URL,
    },
    maxTokens: 2000,
    temperature: 0.3,
  });

  const fullContext = state.messages
    .map((message) => `${message._getType()}: ${message.content}`)
    .join("\n");

  const systemPrompt = `你是一个负责将用户问题拆解成子任务的任务拆解助手。
                        具体职责为将用户的输入拆解后以
                        JSON:{ task: [{ id: string, description: string, needSearch: boolean }] }格式返回，
                        各属性分别代表task的标识id，任务的描述和该任务是否需要进行网络web搜索查询信息`;

  const agent = createAgent({
    model: model,
    systemPrompt: systemPrompt,
  });

  const response = await agent.invoke({ messages: state.input });
  const messages = response.messages;
  const lastMessages = messages[messages.length - 1];

  function extractJsonFromMarkdown(content: string): any {
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch (error) {
        console.error("JSON 解析错误:", error);
        return null;
      }
    }

    try {
      return JSON.parse(content);
    } catch (error) {
      console.error("直接解析 JSON 失败:", error);
      return null;
    }
  }

  const content = lastMessages.content as string;
  const parsedData = extractJsonFromMarkdown(content);

  if (parsedData && parsedData.task) {
    const tasks: taskType[] = parsedData.task.map(
      (task: { id: string; description: string; needSearch: boolean }) => ({
        ...task,
        status: "pending",
      })
    );
    console.log("解析的任务:", tasks);
    return { tasks };
  } else {
    console.error("无法提取任务数据");
    return { tasks: [] };
  }
}

// 信息收集子searchAgent
async function searchAgent(state: typeof StateAnnotation.State) {
  const searchPendingTasks = state.tasks.filter(
    (t) => t.status === "pending" && t.needSearch
  );
  if (!searchPendingTasks.length) return { tasks: [] };

  const systemPrompt = `你是个网络搜索助手
                        接收一个网络搜索任务，调用searchWebTool进行相关搜索并返回结果`;

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
    configuration: {
      baseURL: process.env.OPENAI_QWEN_BASE_URL,
    },
    maxTokens: 2000,
    temperature: 0.3,
    timeout: 15000,
  });

  const agent = createAgent({
    model: model,
    tools: [searchWebTool],
    systemPrompt: systemPrompt,
  });

  try {
    let results = [];
    for (const task of searchPendingTasks) {
      console.log(`正在搜索任务: ${task.description}`);

      const response = await agent.invoke({
        messages: [{ role: "user", content: task.description }],
      });

      console.log("agentResponse", response);

      const finalResult =
        response.messages[response.messages.length - 1].content;
      console.log("最终结果:", finalResult);

      results.push({
        ...task,
        status: "searched",
        searchResult: finalResult,
      });
    }

    return { tasks: results };
  } catch (error) {
    console.error("调用出现错误:", error);
    throw error;
  }
}

async function infoHandleAgent(state: typeof StateAnnotation.State) {
  const tasksWaitProcess = state.tasks.filter(
    (task) =>
      task.status === "searched" ||
      (task.status === "pending" && !task.needSearch)
  );

  if (!tasksWaitProcess.length) return { tasks: [] };
  const model = new ChatOpenAI({
    model: "qwen-flash",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: {
      baseURL: process.env.OPENAI_QWEN_BASE_URL,
    },
    maxTokens: 2000,
    temperature: 0.3,
  });

  const systemPrompt = `你是一个负责处理所有信息的的信息处理助手。
                        具体职责为将已处理的task的所有信息，
                        (包含用户问题${state.input}直接拆解的任务的描述以及需要进行搜索的task搜索后返回的数据context)
                        进行处理，返回整理好的结果`;

  const agent = createAgent({
    model: model,
    systemPrompt: systemPrompt,
  });

  const tasks = [];
  for (const task of tasksWaitProcess) {
    const context = task.searchResult || "";
    const response = await agent.invoke({
      messages: `Process task: ${task.description} Context: ${context}`,
    });
    const messages = response.messages;
    const finalResult = messages[messages.length - 1].content;

    tasks.push({
      ...task,
      status: "processed" as const,
      result: [finalResult],
    });
  }

  return { tasks };
}

async function summaryAgent(state: typeof StateAnnotation.State) {
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

  const systemPrompt = `你是一个负责将所有已处理的信息总结成最后答案的汇总报告助手。
                        你知道用户的原始问题：${state.input}
                        具体职责为将所有tasks处理后汇总的信息进行最后的处理，生成用户需要的最终答案返回`;

  const agent = createAgent({
    model: model,
    systemPrompt: systemPrompt,
  });

  const results = state.tasks.map((task) => task.result).filter(Boolean);
  const response = await agent.invoke({
    messages: `总结汇总信息输出最终回复：${results.join("\n\n")}`,
  });

  const summary = response.messages[response.messages.length - 1].content;

  return { summary: summary };
}

function getRouteFromState(state: typeof StateAnnotation.State): string {
  return state.nextAgent || "__end__";
}

// const workflow = new StateGraph(StateAnnotation)
//   .addNode("supervisorAgent", supervisorAgent)
//   .addNode("taskDecomposerAgent", taskDecomposerAgent)
//   .addNode("searchAgent", searchAgent)
//   .addNode("infoHandleAgent", infoHandleAgent)
//   .addNode("summaryAgent", summaryAgent)

//   .addEdge(START, "supervisorAgent")

//   .addConditionalEdges("supervisorAgent", getRouteFromState, {
//     taskDecomposerAgent: "taskDecomposerAgent",
//     searchAgent: "searchAgent",
//     infoHandleAgent: "infoHandleAgent",
//     summaryAgent: "summaryAgent",
//     __end__: END,
//   })

//   .addEdge("taskDecomposerAgent", "supervisorAgent")
//   .addEdge("searchAgent", "supervisorAgent")
//   .addEdge("infoHandleAgent", "supervisorAgent")
//   .addEdge("summaryAgent", "supervisorAgent")

//   .compile();

const multiWorkflow = new StateGraph(StateAnnotation)
  .addNode("supervisorAgent", () => ({}))
  .addNode("taskDecomposerAgent", taskDecomposerAgent)
  .addNode("searchAgent", searchAgent)
  .addNode("infoHandleAgent", infoHandleAgent)
  .addNode("summaryAgent", summaryAgent)

  .addEdge(START, "supervisorAgent")

  .addConditionalEdges("supervisorAgent", supervisorAgent, {
    taskDecomposerAgent: "taskDecomposerAgent",
    searchAgent: "searchAgent",
    infoHandleAgent: "infoHandleAgent",
    summaryAgent: "summaryAgent",
    __end__: END,
  })

  .addEdge("taskDecomposerAgent", "supervisorAgent")
  .addEdge("searchAgent", "supervisorAgent")
  .addEdge("infoHandleAgent", "supervisorAgent")
  .addEdge("summaryAgent", "supervisorAgent")

  .compile();

// 测试工作流的函数
// async function testWorkflow() {
//   console.log("开始测试工作流...");

//   try {
// 测试用例1
// const testInput1 = "帮我搜索一下蜂鸟的最高时速";
// console.log(`\n=== 测试用例1: ${testInput1} ===`);

// const result1 = await workflow.invoke({
//   input: testInput1,
//   tasks: [],
//   nextAgent: "",
//   summary: "",
// });

// console.log("工作流结果1:", JSON.stringify(result1, null, 2));

// 测试用例2
//     const testInput2 = "帮我整理原神6.1月之二版本的主线剧情脉络";
//     console.log(`\n=== 测试用例2: ${testInput2} ===`);

//     const result2 = await workflow.invoke({
//       input: testInput2,
//       tasks: [],
//       nextAgent: "",
//       summary: "",
//     });

//     console.log("工作流结果2:", JSON.stringify(result2, null, 2));
//   } catch (error) {
//     console.error("测试过程中出现错误:", error);
//   }
// }

// // 测试单个agent的函数
// async function testSingleAgent() {
//   console.log("测试单个搜索agent...");

//   const testState = {
//     input: "帮我搜索一下蜂鸟的最高时速",
//     tasks: [
//       {
//         id: "1",
//         description: "蜂鸟的最高时速",
//         needSearch: true,
//         status: "pending" as const,
//       },
//     ],
//     nextAgent: "",
//     summary: "",
//   };

//   try {
//     const result = await searchAgent(testState);
//     console.log("搜索agent结果:", JSON.stringify(result, null, 2));
//   } catch (error) {
//     console.error("搜索agent测试失败:", error);
//   }
// }

// // 如果直接运行此文件，执行测试
// if (require.main === module) {
//   console.log("选择测试模式:");
//   console.log("1. 测试完整工作流");
//   console.log("2. 测试单个搜索agent");

//   const args = process.argv.slice(2);
//   const mode = args[0] || "1";

//   if (mode === "1") {
//     testWorkflow().catch(console.error);
//   } else if (mode === "2") {
//     testSingleAgent().catch(console.error);
//   } else {
//     console.log("无效的测试模式，使用默认模式1");
//     testWorkflow().catch(console.error);
//   }
// }

// 导出工作流和测试函数
export { multiWorkflow };
