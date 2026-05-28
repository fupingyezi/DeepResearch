import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib";
import { ChatMessageType, fileMetadataType } from "@/types";

export async function POST(request: NextRequest) {
  try {
    const { sessionId } = await request.json();

    if (!sessionId) {
      return NextResponse.json(
        {
          message: "Session ID is required",
        },
        { status: 400 }
      );
    }

    const messagesQuery = `
      select * from chat_message 
      where session_id = $1 
      order by id
    `;

    const messagesResponse = await query(messagesQuery, [sessionId]);

    const processedData: ChatMessageType[] = [];

    for (const message of messagesResponse.rows) {
      const fileMetadataQuery = `
        select 
          id,
          message_id as "messageId",
          session_id as "sessionId",
          filename,
          mime_type as "mimeType",
          size_bytes as "sizeBytes",
          minio_bucket as "minioBucket",
          minio_key as "minioKey",
          uploaded_at as "uploadedAt"
        from file_metadata
        where session_id = $1 and message_id = $2
      `;

      const fileMetadataResult = await query(fileMetadataQuery, [
        message.session_id,
        message.id,
      ]);

      const files = fileMetadataResult.rows.map((row) => ({
        id: row.id,
        messageId: row.messageId,
        sessionId: row.sessionId,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: Number(row.sizeBytes),
        minioBucket: row.minioBucket,
        minioKey: row.minioKey,
        uploadedAt: new Date(row.uploadedAt),
      })) as fileMetadataType[];

      const processedMessage: ChatMessageType = {
        id: message.id,
        sessionId: message.session_id,
        role: message.role,
        content: message.content,
        files: files,
      };

      processedData.push(processedMessage);
    }

    return NextResponse.json(
      {
        message: "Get messages success!",
        data: processedData,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Get messages error:", error);
    return NextResponse.json(
      {
        message: "Get messages failed!",
        error: error,
      },
      { status: 500 }
    );
  }
}
