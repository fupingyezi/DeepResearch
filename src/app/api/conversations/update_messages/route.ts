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
        const contentString =
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content);

        // 更新 chat_message
        const updateMsgQuery = `
          UPDATE chat_message
          SET
            role = $3,
            content = $4,
            file_count = $5,
            accumulated_token_usage = $6,
            mode = $7,
            research_status = $8
          WHERE session_id = $1 AND id = $2;
        `;

        const msgValues = [
          message.sessionId,
          message.id,
          message.role,
          contentString,
          message.files?.length || 0,
          message.accumulatedTokenUsage || 0,
          message.mode || "chat",
          message.researchStatus || "failed",
        ];

        await client.query(updateMsgQuery, msgValues);

        if (
          message.mode === "deepResearch" &&
          message.researchStatus === "finished"
        ) {
          const dr = message.deepResearchResult;
          const cleanResearchTarget = (dr.researchTarget || "")
            .toString()
            .trim();
          const cleanReport = (dr.report || "").toString().trim();

          // 更新 deep_research_result
          const updateDRQuery = `
            UPDATE deep_research_result
            SET
              research_target = $3,
              report = $4
            WHERE session_id = $1 AND message_id = $2
            RETURNING id;
          `;

          const drRes = await client.query(updateDRQuery, [
            message.sessionId,
            message.id,
            cleanResearchTarget,
            cleanReport,
          ]);

          if (drRes.rows.length === 0) {
            throw new Error(
              `deep_research_result not found for session_id: ${message.sessionId}, message_id: ${message.id}`
            );
          }
          const researchResultId = drRes.rows[0].id;

          // 删了重插
          await client.query(
            "DELETE FROM research_task_search_result WHERE task_id IN (SELECT id FROM research_task WHERE research_result_id = $1)",
            [researchResultId]
          );
          await client.query(
            "DELETE FROM research_task WHERE research_result_id = $1",
            [researchResultId]
          );

          for (const task of dr.tasks || []) {
            const cleanDescription = (task.description || "").toString().trim();
            const cleanResult = task.result
              ? task.result.toString().trim()
              : null;

            const insertTaskQuery = `
              INSERT INTO research_task (
                id,
                task_id,
                research_result_id,
                description,
                need_search,
                result
              ) VALUES ($1, $2, $3, $4, $5, $6);
            `;

            await client.query(insertTaskQuery, [
              task.id,
              task.taskId,
              researchResultId,
              cleanDescription,
              !!task.needSearch,
              cleanResult,
            ]);

            for (const sr of task.searchResult || []) {
              const insertSRQuery = `
                INSERT INTO research_task_search_result (
                  task_id,
                  title,
                  source_url,
                  content,
                  relative_score
                ) VALUES ($1, $2, $3, $4, $5);
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
          // 先删除现有的文件元数据，然后重新插入
          await client.query(
            "DELETE FROM file_metadata WHERE session_id = $1 AND message_id = $2",
            [userMessage.sessionId, userMessage.id]
          );

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
        updated_count: chat_messages.length,
      });
    } catch (dbError) {
      await client.query("ROLLBACK");
      console.error("Database transaction failed:", dbError);
      return NextResponse.json(
        {
          error: "Failed to update messages and research results",
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
