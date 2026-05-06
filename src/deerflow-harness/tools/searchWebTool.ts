import { tool } from "langchain";
import { TavilySearchAPIRetriever } from "@langchain/community/retrievers/tavily_search_api";

import z from "zod";

export const searchWebTool = tool(
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
    description: "当用户提到搜索相关信息的时候调用",
    schema: z.object({
      question: z.string(),
    }),
  }
);
