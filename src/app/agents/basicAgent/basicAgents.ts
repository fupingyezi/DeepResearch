import { createAgent } from "langchain";
import { getCheckpointer } from "@/lib";
import { buildLLM } from "@/lib/llm";
import { UUIDTypes } from "uuid";

const systemPrompt = `你是一个智能、专业且可靠的AI助手。请始终以清晰、准确的方式回答用户问题，并严格遵守以下输出格式规范：

1. 所有数学公式必须使用 LaTeX 语法：
   - 行内公式必须用单美元符号包裹，例如：$E = mc^2$
   - 独立公式必须用双美元符号包裹，前后换行，例如：
     $$ G_{\mu\nu} + \Lambda g_{\mu\nu} = \\frac{8\\pi G}{c^4} T_{\mu\nu} $$

2. 不要将公式放入代码块（即不要使用三个反引号包裹公式），也不要使用 \`\`\`math、\`\`\`latex 等标记。

3. 仅在确实需要展示编程代码时，才使用三个反引号包裹代码，并标明语言（如 \`\`\`python）。普通解释、公式、文本一律不用代码块。

4. 禁止使用 HTML 标签、非标准公式语法（如 \(...\) 或 \[...\]），或未包裹的 LaTeX。

5. 保持语言自然、简洁、专业，确保科学内容准确。

你的输出将被传入一个支持 $...$ 和 $$...$$ 的 ReactMarkdown 渲染器，请务必按上述规则生成纯 Markdown 文本。`;

// 非流式传输调用
async function chatAgent(message: string, sessionId: UUIDTypes) {
  const checkpointer = await getCheckpointer();
  const model = buildLLM("qwen");

  const agent = createAgent({
    model: model,
    systemPrompt: systemPrompt,
    checkpointer: checkpointer,
  });

  return agent.invoke(
    { messages: [{ role: "human", content: message }] },
    { configurable: { thread_id: sessionId } },
  );
}

// 流式调用
async function* chatAgentStream(
  message: string,
  sessionId: UUIDTypes,
  streamMode: "messages" | "updates" | "values",
) {
  const checkpointer = await getCheckpointer();
  const model = buildLLM("qwen", { streaming: true });

  const agent = createAgent({
    model: model,
    systemPrompt: systemPrompt,
    checkpointer: checkpointer,
  });

  const stream = await agent.stream(
    { messages: [{ role: "human", content: message }] },
    {
      streamMode: streamMode,
      configurable: { thread_id: sessionId },
    },
  );

  switch (streamMode) {
    case "values": {
    }
    case "messages": {
      for await (const chunk of stream) {
        if (chunk && chunk.length > 0) {
          const message = chunk[0];
          if (message.content) {
            yield {
              content: message.content,
              type: "content",
              role: "assistant",
              id: message.id,
            };
          }
        }
      }
      return;
    }
    case "updates": {
      for await (let chunk of stream) {
        chunk = chunk.model_request;
        if (chunk.messages && chunk.messages.length > 0) {
          const message = chunk.messages[chunk.messages.length - 1];
          if (message.content) {
            yield {
              content: message.content,
              type: "content",
              role: "assistant",
              id: message.id,
            };
          }
        }
      }
      return;
    }
  }
}

export { chatAgent, chatAgentStream };
