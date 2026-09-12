import { NextRequest, NextResponse } from 'next/server';
import { getClient, query } from '@/lib';
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
    try {
      await client.query('begin');

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
    // 残留说明：若该对话的 run 此刻仍在后台跑（run 是 fire-and-forget，没有服务端取消
    // 接口），它还会继续为这个 thread 写 checkpoint，直到自己结束 —— 残留量被限制在
    // 「这一轮 run 的 checkpoint」内，而非此前的整段对话历史。
    await cleanupAgentSideData(sessionId, user.id);

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
