import { NextRequest, NextResponse } from 'next/server';

import { clearMemoryData, getMemoryData } from '@/deerflow-harness';
import { getCurrentUser } from '../auth/_helpers';

/** 读取当前用户的记忆（结构化 summary + facts）。 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    // lead 对话使用跨 agent 全局 per-user 记忆（agentName=null → users/{userId}/memory.json），
    // 与注入侧 / 异步写入侧保持一致，对齐 deer-flow 2.0 默认对话 agent_name=None 行为。
    const data = await getMemoryData(null, user.id);
    return NextResponse.json({ message: 'Get memory success!', data }, { status: 200 });
  } catch (error) {
    console.error('[memory] get error:', error);
    return NextResponse.json(
      {
        message: 'Get memory failed!',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

/** 清空当前用户的全部记忆。 */
export async function DELETE(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const data = await clearMemoryData(null, user.id);
    return NextResponse.json({ message: 'Clear memory success!', data }, { status: 200 });
  } catch (error) {
    console.error('[memory] clear error:', error);
    return NextResponse.json(
      {
        message: 'Clear memory failed!',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
