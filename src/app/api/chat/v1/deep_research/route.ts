/**
 * @deprecated v1 路由，请使用 /api/chat/v2 统一路由替代。
 * 此路由保留以支持渐进式迁移，后续版本将移除。
 */

import { handleStateUpdate } from "@/utils/handleStateUpdate";
import { createSSEStream } from "@/lib/stream/createSSEStream";
import { AgentManager, AgentType, DeepResearchAgentServer } from "@/agents";
import { AgentEventType } from "@/types";

// 注册Agent工厂函数
const agentManager = AgentManager.getInstance();
agentManager.registerAgent(AgentType.DEEP_RESEARCH, () => {
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
      if (chunk.eventType === AgentEventType.STATE_UPDATE) {
        const updateState = handleStateUpdate(lastState, (chunk as any).payload?.data);
        if (updateState) {
          enqueue(updateState);
          lastState = (chunk as any).payload?.data;
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
