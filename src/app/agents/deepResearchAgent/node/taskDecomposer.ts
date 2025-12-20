import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";

import ResearchStateAnnotation from "../workState";

import { taskType } from "@/types";

export async function taskDecomposer(
  state: typeof ResearchStateAnnotation.State
) {
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
    return { tasks, needsHumanReview: true, curAction: "taskDecompose" };
  } else {
    console.error("解析结果中缺少有效的 tasks 数组", parsedData);
    return { tasks: [], needsHumanReview: true };
  }
}
