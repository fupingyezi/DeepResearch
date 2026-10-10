/**
 * memory 域 HTTP 层逻辑（自 route.ts 抽出）；route.ts 是薄适配器。
 *
 * 覆盖 /api/memory（get/clear）、facts、facts/[id]、mode、retrieve 五个路由的 handler。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { ApiRouteHandler } from '@/backend/http';
import { getMemoryService } from '@/backend/services/memory-service';
import { previewRetrieval } from '@/backend/services/memory-service.preview';
import {
  createMemoryFactSchema,
  setMemoryModeSchema,
  updateMemoryFactSchema,
} from '@/backend/validation/schemas';
import { retrievePreviewSchema } from '@/backend/validation/schemas.preview';

/** 读取当前用户的记忆（结构化 summary + facts）。 */
export const get: ApiRouteHandler<undefined, undefined> = async ({ user }) => {
  const data = await getMemoryService().getMemory(user!.id);
  return NextResponse.json({ message: 'Get memory success!', data }, { status: 200 });
};

/** 清空当前用户的全部记忆。 */
export const clear: ApiRouteHandler<undefined, undefined> = async ({ user }) => {
  const data = await getMemoryService().clearMemory(user!.id);
  return NextResponse.json({ message: 'Clear memory success!', data }, { status: 200 });
};

/** 新增一条记忆 fact（来源标记为 manual）。 */
export const createFact: ApiRouteHandler<
  z.infer<typeof createMemoryFactSchema>,
  undefined
> = async ({ user, body }) => {
  const data = await getMemoryService().createFact(user!.id, body);
  return NextResponse.json({ message: 'Create fact success!', data }, { status: 200 });
};

/** 更新指定记忆 fact 的内容/分类/置信度。 */
export const updateFact: ApiRouteHandler<
  z.infer<typeof updateMemoryFactSchema>,
  undefined
> = async ({ user, body, params }) => {
  const data = await getMemoryService().updateFact(user!.id, params.id, body);
  return NextResponse.json({ message: 'Update fact success!', data }, { status: 200 });
};

/** 删除指定记忆 fact。 */
export const deleteFact: ApiRouteHandler<undefined, undefined> = async ({ user, params }) => {
  const data = await getMemoryService().deleteFact(user!.id, params.id);
  return NextResponse.json({ message: 'Delete fact success!', data }, { status: 200 });
};

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
export const getMode: ApiRouteHandler<undefined, undefined> = async ({ user }) => {
  const data = await getMemoryService().getMode(user!.id);
  return NextResponse.json({ message: 'Get memory mode success!', data }, { status: 200 });
};

export const setMode: ApiRouteHandler<z.infer<typeof setMemoryModeSchema>, undefined> = async ({
  user,
  body,
}) => {
  await getMemoryService().setMode(user!.id, body.mode);
  return NextResponse.json(
    { message: 'Set memory mode success!', data: { mode: body.mode } },
    { status: 200 },
  );
};

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
 * harness 的 injection.preview.ts），本控制器只是薄控制器。
 *
 * 注：本接口只读不写，无前端消费者（明细形状可随管线演进）；会触发旧数据
 * 向量回填（fire-and-forget，与线上行为一致）。
 */
export const retrievePreview: ApiRouteHandler<
  undefined,
  z.infer<typeof retrievePreviewSchema>
> = async ({ user, query }) => {
  const data = await previewRetrieval(user!.id, query.q);
  return NextResponse.json({ message: 'Retrieve preview success!', data }, { status: 200 });
};

export const memoryController = {
  get,
  clear,
  createFact,
  updateFact,
  deleteFact,
  getMode,
  setMode,
  retrievePreview,
};
