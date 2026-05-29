import { NextRequest, NextResponse } from 'next/server';
import { getClient, query } from '@/lib';

export async function POST(request: NextRequest) {
  try {
    const { sessionId, title } = await request.json();

    if (!sessionId || !title) {
      return NextResponse.json({ error: 'SessionId and title is lacked!' }, { status: 400 });
    }

    const updateQuery = `
      update chat_session 
      set title = $1, updated_at = $2 
      where id = $3 
      returning *;
    `;

    const now = new Date().toISOString();
    const response = await query(updateQuery, [title, now, sessionId]);

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

export async function DELETE(request: NextRequest) {
  try {
    const { sessionId } = await request.json();

    if (!sessionId) {
      return NextResponse.json({ error: 'Missing required field: sessionId' }, { status: 400 });
    }

    const client = await getClient();
    try {
      await client.query('begin');

      await client.query(
        `
        delete from chat_message where session_id = $1
      `,
        [sessionId],
      );

      const deleteSessionResult = await client.query(
        `
        delete from chat_session where id = $1 returning *
      `,
        [sessionId],
      );

      if (deleteSessionResult.rows.length === 0) {
        await client.query('rollback');
        return NextResponse.json({ error: 'Session not found' }, { status: 404 });
      }

      await client.query('commit');

      return NextResponse.json(
        {
          success: true,
          message: 'Session and all related data deleted successfully',
          deletedSession: deleteSessionResult.rows[0],
        },
        { status: 200 },
      );
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
