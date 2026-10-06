/**
 * GET /api/memory/retrieve?q=<query>
 *
 * 记忆「检索模式」效果预览：走与真实注入**完全相同**的代码路径
 * （previewMemoryRetrieval → retrieveForInjection → retrieveMemory），返回：
 * - 逐条 fact / section 的打分明细：词面重叠率 / 余弦（null=该路未参与）/
 *   所在召回腿（inVectorLeg）/ RRF 分 / rerank 分（null=未精排）/ final 加权分 /
 *   是否真的入选（picked 取自 retrieveMemory 的真实结果，不是本接口另行判定）；
 * - 管线级汇总：poolSize / rerankUsed / vectorLeg（pg 或 js 兜底）；
 * - 最终会拼进 system prompt 的整段文本（injectedText）——直接看模型看到的东西；
 * - 当前生效的配置与语义门槛，便于解读"为什么这条没被选中"。
 *
 * 设置页已提供「全量注入 / 按需检索」切换（PUT /api/memory/mode）；本接口
 * 是单 query 粒度的检索诊断入口，不依赖前端开关状态。
 *
 * 预览代码独立在 *.preview.ts（memory-service.preview.ts / schemas.preview.ts /
 * harness 的 injection.preview.ts），本路由只是薄控制器。
 *
 * 注：本接口只读不写，无前端消费者（明细形状可随管线演进）；会触发旧数据
 * 向量回填（fire-and-forget，与线上行为一致）。
 */

import { NextResponse } from 'next/server';

import { withApiHandler } from '@/server/http';
import { previewRetrieval } from '@/server/services/memory-service.preview';
import { retrievePreviewSchema } from '@/server/validation/schemas.preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApiHandler(
  { query: retrievePreviewSchema, fallbackMessage: 'Retrieve preview failed' },
  async ({ user, query }) => {
    const data = await previewRetrieval(user!.id, query.q);
    return NextResponse.json({ message: 'Retrieve preview success!', data }, { status: 200 });
  },
);
