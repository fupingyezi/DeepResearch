import { NextRequest, NextResponse } from "next/server";
import { ConvertLangChainMessageToRoleMessage } from "@/utils";
import { chatAgent, chatAgentStream } from "@/app/agents";
import { SSEEvent } from "@/types";
import { createSSEStream } from "../../utils/createSSEStream";
import { query } from "@/lib/db";

export async function POST(request: NextRequest) {
  try {
    const {
      input,
      sessionId,
      stream = true,
      hasFiles = false,
      uploadedFiles = [],
    } = await request.json();

    if (!input) {
      return NextResponse.json({ error: "input is required" }, { status: 400 });
    }

    if (!stream) {
      // 如果有文件，获取文件内容并附加到输入中
      let fullInput = input;
      if (hasFiles && uploadedFiles.length > 0) {
        let fileContents = "\n\n--- 附件内容 ---\n";
        for (const file of uploadedFiles) {
          // 从file_content表获取已解析的内容
          const contentResult = await query(
            `SELECT content FROM file_content WHERE minio_key = $1 AND status = 'success'`,
            [file.minioKey]
          );

          if (contentResult.rows.length > 0) {
            fileContents += `\n文件: ${file.filename}\n内容:\n${contentResult.rows[0].content}\n\n`;
          }
        }
        fileContents += "--- 附件内容结束 ---\n\n";
        fullInput = input + fileContents;
      }

      const response = await chatAgent(fullInput, sessionId);
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

      // 如果有文件，获取文件内容并附加到输入中
      let fullInput = input;
      if (hasFiles && uploadedFiles.length > 0) {
        let fileContents = "\n\n--- 附件内容 ---\n";
        for (const file of uploadedFiles) {
          // 从file_content表获取已解析的内容
          const contentResult = await query(
            `SELECT content FROM file_content WHERE minio_key = $1 AND status = 'success'`,
            [file.minioKey]
          );

          if (contentResult.rows.length > 0) {
            fileContents += `\n文件: ${file.filename}\n内容:\n${contentResult.rows[0].content}\n\n`;
          }
        }
        fileContents += "--- 附件内容结束 ---\n\n";
        fullInput = input + fileContents;
      }

      for await (const chunk of chatAgentStream(
        fullInput,
        sessionId,
        "messages"
      )) {
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
