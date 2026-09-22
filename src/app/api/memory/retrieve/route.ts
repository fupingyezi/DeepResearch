/**
 * GET /api/memory/retrieve?q=<query>
 *
 * 记忆「检索模式」效果预览：走与真实注入**完全相同**的代码路径
 * （previewMemoryRetrieval → retrieveForInjection），返回：
 * - 逐条 fact 的打分明细：词面重叠率 / 余弦 / 是否过语义阈值 / 混合得分 /
 *   是否真的入选（picked 取自 retrieveMemory 的真实结果，不是本接口另行判定）；
 * - 最终会拼进 system prompt 的整段文本（injectedText）——直接看模型看到的东西；
 * - 当前生效的配置与两个门槛常量，便于解读"为什么这条没被选中"。
 *
 * 设置页已提供「全量注入 / 按需检索」切换（PUT /api/memory/mode）；本接口
 * 是单 query 粒度的检索诊断入口，不依赖前端开关状态。
 *
 * 注：本接口只读不写；但会触发旧数据向量回填（fire-and-forget，与线上行为一致）。
 */

import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser, toHttpError } from '@/server/http';
import { getMemoryService } from '@/server/services/memory-service';
import { parseSearchParams } from '@/server/validation';
import { retrievePreviewSchema } from '@/server/validation/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const parsed = parseSearchParams(request.nextUrl.searchParams, retrievePreviewSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const data = await getMemoryService().previewRetrieval(user.id, parsed.data.q);
    return NextResponse.json({ message: 'Retrieve preview success!', data }, { status: 200 });
  } catch (error) {
    console.error('[memory/retrieve] preview error:', error);
    return toHttpError(error, 'Retrieve preview failed');
  }
}
