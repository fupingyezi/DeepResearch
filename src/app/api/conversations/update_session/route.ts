import { NextRequest, NextResponse } from 'next/server';
import { deleteFile, getClient, query } from '@/lib';
import { getCurrentUser } from '../../auth/_helpers';
import { getThreadService } from '../../threads/_service';

export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const { sessionId, title } = await request.json();

    if (!sessionId || !title) {
      return NextResponse.json({ error: 'SessionId and title is lacked!' }, { status: 400 });
    }

    const updateQuery = `
      update chat_session 
      set title = $1, updated_at = $2 
      where id = $3 and user_id = $4
      returning *;
    `;

    const now = new Date().toISOString();
    const response = await query(updateQuery, [title, now, sessionId, user.id]);

    if (response.rows.length === 0) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    return NextResponse.json(
      {
        success: true,
        message: 'Session updated successfully',
        data: response.rows[0],
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('Update session error:', error);
    return NextResponse.json(
      {
        error: 'Failed to update session',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

/**
 * 清理与 thread_id 同 id 的 agent 侧数据（threads_meta / runs / LangGraph checkpoint /
 * 沙箱容器）。
 *
 * 复用 ThreadService.deleteThread —— 它已封装「meta 删除 + 沙箱释放 + checkpoint 清理」
 * 三步与各自的容错，保持「删 thread」只有一份实现。
 *
 * 尽力而为：thread 记录本就不存在（老会话）时 store 的 assertOwner 会抛 FORBIDDEN，
 * 那属于「没什么可清」的正常情况；任何失败都只告警，不影响删除结果。
 */
async function cleanupAgentSideData(threadId: string, userId: string): Promise<void> {
  try {
    const threadService = await getThreadService();
    await threadService.deleteThread({ thread_id: threadId, user_id: userId });
  } catch (error) {
    console.warn(
      `[DELETE session] agent-side cleanup failed for ${threadId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * 删除会话关联的上传文件：MinIO 对象 + file_content 解析记录。
 *
 * 两道保护：
 *   1. 只删「已无任何会话引用」的对象 —— 同一个 fileId 可能在别的会话里被再次发送
 *      （前端文件列表是全局的，切走会话不一定会清空），库里 file_metadata 也允许多会话
 *      并存同键。调用点在本会话行已随事务删掉之后，因此此刻还查得到的引用必然是别人的。
 *   2. 单键失败只告警：对象删不掉不该把「对话已删除」这个结果反悔成 500。
 */
async function cleanupSessionFiles(minioKeys: string[]): Promise<void> {
  if (minioKeys.length === 0) return;

  let stillReferenced: string[];
  try {
    const res = await query(
      `select distinct minio_key from file_metadata where minio_key = any($1::text[]);`,
      [minioKeys],
    );
    stillReferenced = res.rows.map((row: Record<string, unknown>) => String(row.minio_key ?? ''));
  } catch (error) {
    // 查不清引用关系就不动对象：宁可留垃圾，不能误删别处还在用的文件
    console.warn(
      '[DELETE session] failed to check file references, skip object removal:',
      error instanceof Error ? error.message : error,
    );
    return;
  }

  const removable = minioKeys.filter((key) => !stillReferenced.includes(key));
  if (removable.length === 0) return;

  for (const key of removable) {
    try {
      await deleteFile(key);
    } catch (error) {
      console.warn(
        `[DELETE session] failed to remove object ${key}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  try {
    await query(`delete from file_content where minio_key = any($1::text[]);`, [removable]);
  } catch (error) {
    console.warn(
      '[DELETE session] failed to delete file_content rows:',
      error instanceof Error ? error.message : error,
    );
  }
}

export async function DELETE(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const { sessionId } = await request.json();

    if (!sessionId) {
      return NextResponse.json({ error: 'Missing required field: sessionId' }, { status: 400 });
    }

    const client = await getClient();
    let deletedSession: Record<string, unknown>;
    let fileKeys: string[] = [];
    try {
      await client.query('begin');

      // 先把本会话引用过的文件对象键捞出来：file_metadata 行会随 chat_message 级联
      // 消失，而 MinIO 对象不在这个事务里，得留到 commit 之后再去删。
      const fileKeysResult = await client.query(
        `
        select distinct fm.minio_key
          from file_metadata fm
         where fm.session_id = $1
         union
        select distinct fc.minio_key
          from file_content fc
          join file_metadata fm2 on fm2.id = fc.file_id
         where fm2.session_id = $1;
      `,
        [sessionId],
      );
      fileKeys = fileKeysResult.rows
        .map((row: Record<string, unknown>) => String(row.minio_key ?? ''))
        .filter((key: string) => key.length > 0);

      await client.query(
        `
        delete from chat_message where session_id = $1 and user_id = $2
      `,
        [sessionId, user.id],
      );

      const deleteSessionResult = await client.query(
        `
        delete from chat_session where id = $1 and user_id = $2 returning *
      `,
        [sessionId, user.id],
      );

      if (deleteSessionResult.rows.length === 0) {
        await client.query('rollback');
        return NextResponse.json({ error: 'Session not found' }, { status: 404 });
      }

      await client.query('commit');
      deletedSession = deleteSessionResult.rows[0];
    } catch (dbError) {
      await client.query('rollback');
      console.error('Database transaction failed:', dbError);
      return NextResponse.json(
        {
          error: 'Failed to delete session',
          details: dbError instanceof Error ? dbError.message : 'Unknown error',
        },
        { status: 500 },
      );
    } finally {
      client.release();
    }

    // chat_session / chat_message 已删（同一 id 即 thread_id）。agent 侧那套数据不在
    // 这个事务管辖内，删完再单独收尾 —— 否则 conversation 从侧栏消失了，threads_meta、
    // runs 与完整对话 checkpoint 却永久留在库里。
    //
    // 若该对话此刻还有 run 在后台跑，deleteThread 会先取消它并等其收尾，再删 meta 与
    // checkpoint —— 否则 run 会在清理之后继续写 checkpoint，把刚删掉的数据写回来。
    await cleanupAgentSideData(sessionId, user.id);

    // 上传文件本体与解析记录：库里只删了 file_metadata 行，MinIO 对象与 file_content
    // 不会自己消失，不清理就是永久垃圾（且 file_content 仍可按 fileId 被反查到）。
    await cleanupSessionFiles(fileKeys);

    return NextResponse.json(
      {
        success: true,
        message: 'Session and all related data deleted successfully',
        deletedSession,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('Delete session error:', error);
    return NextResponse.json(
      {
        error: 'Invalid request body',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 400 },
    );
  }
}
