import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import dotenv from "dotenv";
import { taskType } from "@/types";

dotenv.config({ path: ".env.local" });

async function testAgent(message: string) {
  const model = new ChatOpenAI({
    model: "qwen-flash",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: {
      baseURL: process.env.OPENAI_QWEN_BASE_URL,
    },
    maxTokens: 2000,
    temperature: 0.3,
  });

  const systemPrompt = `你是一个负责将用户问题拆解成子任务的任务拆解助手。
                        具体职责为将用户的输入拆解后以
                        JSON:{ task: [{ id: string, description: string, needSearch: boolean }] }格式返回，
                        各属性分别代表task的标识id，任务的描述和该任务是否需要进行网络web搜索查询信息`;

  const agent = createAgent({
    model: model,
    systemPrompt: systemPrompt,
  });

  const response = await agent.invoke({ messages: message });
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
    const tasks: taskType[] = parsedData.task;
    // console.log("tasks:", tasks);
    return tasks;
  } else {
    console.error("无法提取任务数据");
    return [];
  }
}

// testAgent("我想要知道学习爱因斯坦场方程所需的基础知识");
