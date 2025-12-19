import { ChatOpenAI } from "@langchain/openai";
import { searchWebTool } from "../tools";
import { createAgent } from "langchain";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const systemPrompt = `你是个网络搜索助手，会使用网络搜索工具来帮助用户搜索相关信息`;

export const ChatAgentWithSearchTool = async (
  input: string,
  config?: Record<string, any>
) => {
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
    const response = await agent.invoke(
      {
        messages: [{ role: "human", content: input }],
      },
      {
        ...config,
      }
    );
    return response;
  } catch (error) {
    console.error("调用出现错误:", error);
    throw error;
  }
};

// ChatAgentWithSearchTool([new HumanMessage("帮我搜索一下蜂鸟的最高时速")])
//   .then((result) => {
//     console.log("最终结果:", result);
//   })
//   .catch((error) => {
//     console.error("执行失败:", error);
//   });
