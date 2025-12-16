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
            content,
            file_count,
            accumulated_token_usage,
            mode,
            research_status
          ) values ($1, $2, $3, $4, $5, $6, $7, $8);
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
          message.files?.length || 0,
          message.accumulatedTokenUsage || 0,
          message.mode || "chat",
          message.researchStatus || "failed",
        ];

        await client.query(insertMsgQuery, msgValues);

        if (
          message.mode === "deepResearch" &&
          message.researchStatus === "finished"
        ) {
          const dr = message.deepResearchResult;

          const cleanResearchTarget = (dr.researchTarget || "")
            .toString()
            .trim();
          const cleanReport = (dr.report || "").toString().trim();

          // 插入 deep_research_result
          const insertDRQuery = `
            insert into deep_research_result (session_id, message_id, research_target, report)
            values ($1, $2, $3, $4)
            returning id;
          `;

          const drRes = await client.query(insertDRQuery, [
            message.sessionId,
            message.id,
            cleanResearchTarget,
            cleanReport,
          ]);

          const researchResultId = drRes.rows[0].id;

          // 插入对应的每个 task
          for (const task of dr.tasks || []) {
            const cleanDescription = (task.description || "").toString().trim();
            const cleanResult = task.result
              ? task.result.toString().trim()
              : null;

            const insertTaskQuery = `
              insert into research_task (
                id,
                task_id,
                research_result_id,
                description,
                need_search,
                result
              ) values ($1, $2, $3, $4, $5, $6);
            `;

            await client.query(insertTaskQuery, [
              task.id,
              task.taskId,
              researchResultId,
              cleanDescription,
              !!task.needSearch,
              cleanResult,
            ]);

            // 插入该 task 的搜索结果
            for (const sr of task.searchResult || []) {
              const insertSRQuery = `
                insert into research_task_search_result (
                  task_id,
                  title,
                  source_url,
                  content,
                  relative_score
                ) values ($1, $2, $3, $4, $5);
              `;

              await client.query(insertSRQuery, [
                task.id,
                sr.title || null,
                sr.sourceUrl || null,
                sr.content || null,
                sr.relativeScore != null ? sr.relativeScore : null,
              ]);
            }
          }
        }
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
          error: "Failed to save messages and research results",
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
