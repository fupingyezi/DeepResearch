import { handleStateUpdate } from "@/utils/handleStateUpdate";
import { createSSEStream } from "@/app/api/utils/createSSEStream";
import { AgentManager, AgentType, DeepResearchAgentServer } from "@/app/agents";

// 注册Agent工厂函数
const agentManager = AgentManager.getInstance();
agentManager.registerFactory(AgentType.DEEP_RESEARCH, () => {
  return new DeepResearchAgentServer({
    model: "qwen-max",
    systemPrompt:
      "You are a helpful assistant that conducts deep research on user queries",
  });
});

export async function POST(request: Request) {
  const { input, deepResearchId, isResume } = await request.json();
  if (!input && isResume === undefined) {
    return new Response(
      JSON.stringify({ error: "Missing input or isResume" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const readableStream = createSSEStream(request, async (enqueue) => {
    let lastState: any = null;
    enqueue({ type: "start", timeStamp: Date.now() });

    const agent = agentManager.getAgent(AgentType.DEEP_RESEARCH);
    const messages = [
      {
        role: "human",
        content: input,
      },
    ];

    for await (const chunk of agent.createMessage(messages, {
      deepResearchId,
      isResume,
    })) {
      if (chunk.type === "state") {
        const updateState = handleStateUpdate(lastState, chunk.state);
        if (updateState) {
          enqueue(updateState);
          lastState = chunk.state;
        }
      }
    }
  });

  return new Response(readableStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
