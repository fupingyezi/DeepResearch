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
 * 存在的意义：`memoryMode: 'retrieve'` 目前没有前端开关（默认走 inject 全量注入），
 * 本接口是观察向量检索效果的唯一入口。
 *
 * 注：本接口只读不写；但会触发旧数据向量回填（fire-and-forget，与线上行为一致）。
 */

import { NextRequest, NextResponse } from 'next/server';

import { previewMemoryRetrieval } from '@/deerflow-harness';
import { ensureMemoryEmbeddingsFactory } from '../../threads/_service';
import { getCurrentUser } from '../../auth/_helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const q = request.nextUrl.searchParams.get('q') ?? '';
  if (!q.trim()) {
    return NextResponse.json(
      { message: 'Missing query', error: '请通过 ?q=<query> 提供检索 query' },
      { status: 400 },
    );
  }

  try {
    // 幂等注册智谱 embedding 工厂（threadService 未初始化时也要能向量化 query，
    // 否则本接口退化为纯词面预览）。与 /api/prompt/enhance 的做法一致。
    ensureMemoryEmbeddingsFactory();

    // 与注入侧同作用域：lead 对话读写「跨 agent 全局 per-user」记忆（agentName=null）
    const data = await previewMemoryRetrieval({ agentName: null, userId: user.id, query: q });
    return NextResponse.json({ message: 'Retrieve preview success!', data }, { status: 200 });
  } catch (error) {
    console.error('[memory/retrieve] preview error:', error);
    return NextResponse.json(
      {
        message: 'Retrieve preview failed!',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
