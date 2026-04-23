/**
 * @deprecated v1 路由，请使用 /api/chat/v2 统一路由替代。
 * 此路由保留以支持渐进式迁移，后续版本将移除。
 */

import { NextRequest, NextResponse } from "next/server";
import { SSEEvent } from "@/types";
import { createSSEStream } from "../../utils/createSSEStream";
// import { query } from "@/lib/db";
import {
  AgentManager,
  AgentType,
  ChatAgentServer,
  CHAT_SYSTEM_PROMPT,
} from "@/app/agents";

const agentManager = AgentManager.getInstance();
agentManager.registerFactory(AgentType.BASIC, () => {
  return new ChatAgentServer({
    model: "qwen-plus",
    systemPrompt: CHAT_SYSTEM_PROMPT,
    streaming: true,
  });
});

export async function POST(request: NextRequest) {
  try {
    const {
      input,
      sessionId,
      hasFiles = false,
      uploadedFiles = [],
    } = await request.json();

    if (!input) {
      return NextResponse.json({ error: "input is required" }, { status: 400 });
    }

    const readableStream = createSSEStream(request, async (enqueue) => {
      enqueue({ type: "start", timeStamp: Date.now() });

      // 如果有文件，获取文件内容并附加到输入中
      let fullInput = input;
      if (hasFiles && uploadedFiles.length > 0) {
        let fileContents = "\n\n--- 附件内容 ---\n";
        for (const file of uploadedFiles) {
          // 从file_content表获取已解析的内容
          // 暂时注释掉数据库相关代码
          // const contentResult = await query(
          //   `SELECT content FROM file_content WHERE minio_key = $1 AND status = 'success'`,
          //   [file.minioKey]
          // );

          // if (contentResult.rows.length > 0) {
          //   fileContents += `\n文件: ${file.filename}\n内容:\n${contentResult.rows[0].content}\n\n`;
          // }
          fileContents += `\n文件: ${file.filename}\n内容: [文件内容暂不可用]\n\n`;
        }
        fileContents += "--- 附件内容结束 ---\n\n";
        fullInput = input + fileContents;
      }

      const agent = agentManager.getAgent(AgentType.BASIC);

      const messages = [
        {
          role: "human",
          content: fullInput,
        },
      ];

      let chunkCount = 0;
      for await (const chunk of agent.createMessage(messages, { sessionId })) {
        chunkCount++;
        console.log(`收到第 ${chunkCount} 个 chunk:`, chunk);

        const data = {
          type: "content",
          content: "text" in chunk ? chunk.text : "",
          role: "assistant",
          id: Date.now().toString(),
          done: false,
        } as SSEEvent;

        console.log("准备 enqueue 数据:", data);
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
      { status: 500 },
    );
  }
}
