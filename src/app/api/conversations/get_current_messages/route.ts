import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib";
import { ChatMessageType, taskType, fileMetadataType } from "@/types";

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
    // console.log("query messages response:", messagesResponse);

    // 处理深度研究情况
    const processedData = [];

    for (const message of messagesResponse.rows) {
      // 在 for (const message of messagesResponse.rows) 循环内部，添加如下代码：

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
        // fileCount: message.file_count,
        // accumulatedTokenUsage: message.accumulated_token_usage,
        mode: message.mode,
        researchStatus: message.research_status,
        files: files,
      };

      if (
        message.mode === "deepResearch" &&
        message.research_status === "finished"
      ) {
        try {
          const deepResearchQuery = `
            select
              dr.id,
              dr.session_id,
              dr.message_id,
              dr.research_target,
              dr.report
            from deep_research_result dr
            where dr.session_id = $1 and dr.message_id = $2
          `;

          const deepResearchResult = await query(deepResearchQuery, [
            message.session_id,
            message.id,
          ]);

          if (deepResearchResult.rows.length > 0) {
            const drData = deepResearchResult.rows[0];

            // 获取相关的任务
            const tasksQuery = `
              select 
                rt.id,
                rt.task_id,
                rt.description,
                rt.need_search,
                rt.result
              from research_task rt
              where rt.research_result_id = $1
              order by rt.task_id
            `;

            const tasksResult = await query(tasksQuery, [drData.id]);

            // 为每个任务查询搜索结果
            const tasks = [];
            for (const task of tasksResult.rows) {
              const searchResultsQuery = `
                select 
                  title,
                  source_url,
                  content,
                  relative_score
                from research_task_search_result
                where task_id = $1
                order by relative_score desc
              `;

              const searchResults = await query(searchResultsQuery, [task.id]);

              tasks.push({
                id: task.id,
                taskId: task.id,
                description: task.description,
                needSearch: task.need_search,
                result: task.result,
                searchResult: searchResults.rows.map((sr) => ({
                  title: sr.title,
                  sourceUrl: sr.source_url,
                  content: sr.content,
                  relativeScore: sr.relative_score,
                })),
              });
            }

            processedMessage.deepResearchResult = {
              messageId: drData.message_id,
              sessionId: drData.session_id,
              researchTarget: drData.research_target,
              report: drData.report,
              tasks: tasks as taskType[],
            };
          }
        } catch (error) {
          console.error(
            `Error fetching deep research result for message ${message.id}:`,
            error
          );
        }
      }

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
