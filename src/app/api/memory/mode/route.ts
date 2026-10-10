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

import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { getMemoryService } from '@/server/services/memory-service';
import { setMemoryModeSchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiHandler(
  { fallbackMessage: 'Get memory mode failed' },
  async ({ user }) => {
    const data = await getMemoryService().getMode(user!.id);
    return NextResponse.json({ message: 'Get memory mode success!', data }, { status: 200 });
  },
);

export const PUT = withApiHandler(
  { body: setMemoryModeSchema, fallbackMessage: 'Set memory mode failed' },
  async ({ user, body }) => {
    await getMemoryService().setMode(user!.id, body.mode);
    return NextResponse.json(
      { message: 'Set memory mode success!', data: { mode: body.mode } },
      { status: 200 },
    );
  },
);
