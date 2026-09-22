/**
 * /api/memory/mode —— 用户的记忆注入模式偏好（跨设备一致，落库 users.memory_mode）。
 *
 * - GET : 返回当前模式；未设置过 → 'inject'（默认），并带 isDefault 标记
 * - PUT : 设置模式。body: { mode: 'inject' | 'retrieve' }
 *
 * 该偏好只影响「记忆如何进入 system prompt」：
 * - inject（默认）：全量注入所有 section 与预算内 facts；
 * - retrieve：按本轮用户输入检索 top-K 相关内容，注入体积更小。
 * 落库而非仅存本地，理由与 selected_model 一致：换浏览器/设备后行为一致。
 */

import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser, toHttpError } from '@/server/http';
import { getMemoryService } from '@/server/services/memory-service';
import { parseJsonBody } from '@/server/validation';
import { setMemoryModeSchema } from '@/server/validation/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const data = await getMemoryService().getMode(user.id);
    return NextResponse.json({ message: 'Get memory mode success!', data }, { status: 200 });
  } catch (error) {
    console.error('[memory/mode] get error:', error);
    return toHttpError(error, 'Get memory mode failed');
  }
}

export async function PUT(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, setMemoryModeSchema);
  if (!parsed.ok) return parsed.response;

  try {
    await getMemoryService().setMode(user.id, parsed.data.mode);
    return NextResponse.json(
      { message: 'Set memory mode success!', data: { mode: parsed.data.mode } },
      { status: 200 },
    );
  } catch (error) {
    console.error('[memory/mode] set error:', error);
    return toHttpError(error, 'Set memory mode failed');
  }
}
