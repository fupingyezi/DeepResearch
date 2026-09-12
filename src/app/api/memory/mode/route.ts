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

import { getMemoryMode, setMemoryMode, type MemoryInjectionMode } from '@deerflow-harness/auth';
import { getCurrentUser } from '../../auth/_helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 服务级默认：与 client.ts 的 baseOptions.memoryMode 保持一致。 */
const DEFAULT_MODE: MemoryInjectionMode = 'inject';

export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  try {
    const stored = await getMemoryMode(user.id);
    return NextResponse.json(
      {
        message: 'Get memory mode success!',
        data: { mode: stored ?? DEFAULT_MODE, isDefault: stored === null },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('[memory/mode] get error:', error);
    return NextResponse.json({ message: 'Get memory mode failed!' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  let mode: unknown;
  try {
    ({ mode } = (await request.json()) as { mode?: unknown });
  } catch {
    return NextResponse.json({ message: 'Invalid JSON body' }, { status: 400 });
  }

  // 严格字面量校验：拼错时明确报错，而不是静默回落默认值改变记忆行为
  if (mode !== 'inject' && mode !== 'retrieve') {
    return NextResponse.json(
      { message: 'Invalid mode', error: "mode must be 'inject' or 'retrieve'" },
      { status: 400 },
    );
  }

  try {
    await setMemoryMode(user.id, mode);
    return NextResponse.json(
      { message: 'Set memory mode success!', data: { mode } },
      { status: 200 },
    );
  } catch (error) {
    console.error('[memory/mode] set error:', error);
    return NextResponse.json({ message: 'Set memory mode failed!' }, { status: 500 });
  }
}
