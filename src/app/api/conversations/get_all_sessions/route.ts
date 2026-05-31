import { NextResponse } from 'next/server';
import { query } from '@/lib';

export async function GET() {
  try {
    const response = await query('select * from chat_session order by updated_at DESC');
    // console.log("query sessions response:", response);

    return NextResponse.json(
      {
        message: 'Get sessions success!',
        data: response.rows || [],
      },
      {
        status: 200,
      },
    );
  } catch (error) {
    console.error('Get sessions error:', error);
    return NextResponse.json(
      {
        message: 'Get sessions failed!',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
