import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/lib";

export async function POST(request: NextRequest) {
  try {
    const {
      chat_messages,
      hasFiles = false,
      uploadedFiles = [],
    } = await request.json();

    if (!Array.isArray(chat_messages) || chat_messages.length === 0) {
      return NextResponse.json(
        { error: "chat_messages must be a non-empty array" },
        { status: 400 }
      );
    }

    const client = await getClient();
    try {
      await client.query("BEGIN");

      for (const message of chat_messages) {
        const insertMsgQuery = `
          insert into chat_message (
            id,
            session_id,
            role,
            content
          ) values ($1, $2, $3, $4);
        `;

        const contentString =
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content);

        const msgValues = [
          message.id,
          message.sessionId,
          message.role,
          contentString,
        ];

        await client.query(insertMsgQuery, msgValues);
      }

      // 如果有文件，插入文件元数据
      if (hasFiles && uploadedFiles.length > 0) {
        const userMessage = chat_messages.find((msg) => msg.role === "user");
        if (userMessage) {
          for (const file of uploadedFiles) {
            const insertFileQuery = `
              INSERT INTO file_metadata (
                id, message_id, session_id, filename, mime_type, size_bytes, minio_bucket, minio_key
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `;

            await client.query(insertFileQuery, [
              file.fileId,
              userMessage.id,
              userMessage.sessionId,
              file.filename,
              file.mimeType,
              file.sizeBytes,
              process.env.MINIO_BUCKET!,
              file.minioKey,
            ]);
          }
        }
      }

      await client.query("COMMIT");

      return NextResponse.json({
        success: true,
        inserted_count: chat_messages.length,
      });
    } catch (dbError) {
      await client.query("ROLLBACK");
      console.error("Database transaction failed:", dbError);
      return NextResponse.json(
        {
          error: "Failed to save messages",
          details: dbError,
        },
        { status: 500 }
      );
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Request parsing error:", error);
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }
}
