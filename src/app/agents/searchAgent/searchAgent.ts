import { searchWebTool } from "../tools";
import { createAgent } from "langchain";
import { buildLLM } from "@/lib/llm";

const systemPrompt = `你是个网络搜索助手，会使用网络搜索工具来帮助用户搜索相关信息`;

export const ChatAgentWithSearchTool = async (
  input: string,
  config?: Record<string, any>,
) => {
  const model = buildLLM("qwen", { model: "qwen-flash" });

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
      },
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
