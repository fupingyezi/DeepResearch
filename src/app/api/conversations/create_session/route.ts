import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib';

function convertTimestamp(timestamp: any): string {
  if (typeof timestamp === 'number') {
    return new Date(timestamp).toISOString();
  }
  if (typeof timestamp === 'string') {
    return timestamp;
  }
  return new Date().toISOString();
}

export async function POST(request: NextRequest) {
  try {
    const { chat_session } = await request.json();

    if (!chat_session || !chat_session.id || !chat_session.seq_id || !chat_session.title) {
      return NextResponse.json(
        { error: 'Missing required fields: id, seq_id, title' },
        { status: 400 },
      );
    }

    try {
      const text = `insert into chat_session (id, seq_id, title, created_at, updated_at) 
                    values ($1, $2, $3, $4, $5) 
                    returning *;`;

      const now = new Date().toISOString();
      const values = [
        chat_session.id,
        chat_session.seq_id,
        chat_session.title,
        convertTimestamp(chat_session.created_at) || now,
        convertTimestamp(chat_session.updated_at) || now,
      ];

      const response = await query(text, values);
      return NextResponse.json(
        {
          success: true,
          data: response.rows[0],
          chat_session: chat_session,
        },
        { status: 201 },
      );
    } catch (dbError) {
      console.error('Database error:', dbError);
      return NextResponse.json(
        { error: 'Failed to create chat session', details: dbError },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error('Request parsing error:', error);
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}
