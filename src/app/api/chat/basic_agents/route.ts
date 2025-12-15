import { NextRequest, NextResponse } from "next/server";
import { ConvertLangChainMessageToRoleMessage } from "@/utils";
import { chatAgent, chatAgentStream } from "@/app/agents";
import { SSEEvent } from "@/types";
import { createSSEStream } from "../../utils/createSSEStream";

export async function POST(request: NextRequest) {
  try {
    const { input, sessionId, stream = true } = await request.json();

    if (!input) {
      return NextResponse.json({ error: "input is required" }, { status: 400 });
    }

    if (!stream) {
      const response = await chatAgent(input, sessionId);
      return NextResponse.json(
        {
          messages: response.messages.map((msg) =>
            ConvertLangChainMessageToRoleMessage(msg)
          ),
        },
        { status: 200 }
      );
    }

    const readableStream = createSSEStream(request, async (enqueue) => {
      enqueue({ type: "start", timeStamp: Date.now() });

      for await (const chunk of chatAgentStream(input, sessionId, "messages")) {
        const data = {
          type: "content",
          content: chunk.content || "",
          role: chunk.role,
          id: chunk.id,
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
  } catch (error) {
    console.error("Error in chat API:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
