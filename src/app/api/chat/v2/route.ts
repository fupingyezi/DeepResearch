/**
 * v2 统一 API 路由
 *
 * 通过 agentType 参数路由到不同的 Agent，所有 Agent 共享同一套 SSE 构建逻辑。
 * 所有事件统一为 AgentEvent 格式，前端可根据 eventType 进行统一分发。
 */

import { NextRequest, NextResponse } from "next/server";
import { createAgentEventSSEStream } from "@/lib/stream/createAgentEventSSEStream";
import {
  AgentManager,
  AgentType,
  ChatAgentServer,
  SearchAgentServer,
  DeepResearchAgentServer,
  CHAT_SYSTEM_PROMPT,
} from "@/agents";

const agentManager = AgentManager.getInstance();

agentManager.registerAgent(AgentType.BASIC, () => {
  return new ChatAgentServer({
    model: "qwen-plus",
    systemPrompt: CHAT_SYSTEM_PROMPT,
    streaming: true,
  });
});

agentManager.registerAgent(AgentType.SEARCH, () => {
  return new SearchAgentServer({
    model: "qwen-flash",
    systemPrompt:
      "You are a helpful assistant that answers user questions with the help of search tools",
  });
});

agentManager.registerAgent(AgentType.DEEP_RESEARCH, () => {
  return new DeepResearchAgentServer({
    model: "qwen-max",
    systemPrompt:
      "You are a helpful assistant that conducts deep research on user queries",
  });
});

const AGENT_TYPE_MAP: Record<string, AgentType> = {
  basic: AgentType.BASIC,
  search: AgentType.SEARCH,
  deep_research: AgentType.DEEP_RESEARCH,
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      agentType,
      input,
      sessionId,
      deepResearchId,
      isResume,
      hasFiles = false,
      uploadedFiles = [],
    } = body;

    // 参数校验
    if (!agentType || !AGENT_TYPE_MAP[agentType]) {
      return NextResponse.json(
        {
          error: `Invalid agentType: ${agentType}. Valid types: ${Object.keys(AGENT_TYPE_MAP).join(", ")}`,
        },
        { status: 400 },
      );
    }

    if (!input && isResume === undefined) {
      return NextResponse.json(
        { error: "Missing input or isResume" },
        { status: 400 },
      );
    }

    const type = AGENT_TYPE_MAP[agentType];
    const agent = agentManager.getAgent(type);

    // 构建消息
    let fullInput = input;
    if (hasFiles && uploadedFiles.length > 0) {
      let fileContents = "\n\n--- 附件内容 ---\n";
      for (const file of uploadedFiles) {
        fileContents += `\n文件: ${file.filename}\n内容: [文件内容暂不可用]\n\n`;
      }
      fileContents += "--- 附件内容结束 ---\n\n";
      fullInput = input + fileContents;
    }

    const messages = [
      {
        role: "human",
        content: fullInput,
      },
    ];

    // 构建元数据
    const metadata: Record<string, any> = {
      sessionId,
    };

    if (agentType === "deep_research") {
      metadata.deepResearchId = deepResearchId;
      metadata.isResume = isResume;
    }

    // 创建 AgentEvent 流并转换为 SSE
    const eventStream = agent.createMessage(messages, metadata);
    const readableStream = createAgentEventSSEStream(request, eventStream);

    return new Response(readableStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Error in v2 chat API:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
