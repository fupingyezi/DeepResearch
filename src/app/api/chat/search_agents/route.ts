import { NextRequest, NextResponse } from "next/server";
import { SSEEvent } from "@/types";
import { createSSEStream } from "../../utils/createSSEStream";
import { AgentManager, AgentType, SearchAgentServer } from "@/app/agents";

// 注册Agent工厂函数
const agentManager = AgentManager.getInstance();
agentManager.registerFactory(AgentType.SEARCH, () => {
  return new SearchAgentServer({
    model: "qwen-max",
    systemPrompt:
      "You are a helpful assistant that answers user questions with the help of search tools",
  });
});

export async function POST(request: NextRequest) {
  try {
    const { input, sessionId, stream = true } = await request.json();

    if (!input) {
      return NextResponse.json({ error: "input is empty" }, { status: 400 });
    }

    const readableStream = createSSEStream(request, async (enqueue) => {
      enqueue({ type: "start", timeStamp: Date.now() });

      // 使用新的Agent系统
      const agent = agentManager.getAgent(AgentType.SEARCH);
      const messages = [
        {
          role: "user",
          content: input,
        },
      ];

      for await (const chunk of agent.createMessage(
        "You are a helpful assistant that answers user questions with the help of search tools",
        messages,
        { sessionId },
      )) {
        const data = {
          type: "content",
          content: "text" in chunk ? chunk.text : "",
          role: "assistant",
          id: Date.now().toString(),
          done: false,
        } as SSEEvent;
        if (!enqueue(data)) break;
      }
    });

    return new Response(readableStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}
