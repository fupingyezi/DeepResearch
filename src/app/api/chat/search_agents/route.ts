/**
 * @deprecated v1 路由，请使用 /api/chat/v2 统一路由替代。
 * 此路由保留以支持渐进式迁移，后续版本将移除。
 */

import { NextRequest, NextResponse } from "next/server";
import { SSEEvent } from "@/types";
import { createSSEStream } from "../../utils/createSSEStream";
import { AgentManager, AgentType, SearchAgentServer } from "@/app/agents";

const agentManager = AgentManager.getInstance();
agentManager.registerFactory(AgentType.SEARCH, () => {
  return new SearchAgentServer({
    model: "qwen-flash",
    systemPrompt:
      "You are a helpful assistant that answers user questions with the help of search tools",
  });
});

export async function POST(request: NextRequest) {
  try {
    const { input, sessionId } = await request.json();

    if (!input) {
      return NextResponse.json({ error: "input is empty" }, { status: 400 });
    }

    const readableStream = createSSEStream(request, async (enqueue) => {
      enqueue({ type: "start", timeStamp: Date.now() });

      const agent = agentManager.getAgent(AgentType.SEARCH);
      const messages = [
        {
          role: "human",
          content: input,
        },
      ];

      for await (const chunk of agent.createMessage(messages, { sessionId })) {
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
