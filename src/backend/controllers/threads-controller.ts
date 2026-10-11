/**
 * threads 域 HTTP 层逻辑（自 src/app/api/threads/**\/route.ts 抽出）；route.ts 是薄适配器。
 *
 * - POST /api/threads：创建 thread
 * - GET  /api/threads：列表
 * - GET    /api/threads/[threadId]：读 meta（?include=checkpoint 时同时返回当前 checkpoint）
 * - DELETE /api/threads/[threadId]：删除 thread + 清理 checkpoint
 * - POST /api/threads/[threadId]/runs：submitRun（fire-and-forget）→ { run_id }
 * - GET  /api/threads/[threadId]/runs：列出 thread 的 runs
 * - GET  /api/threads/[threadId]/runs/[runId]/stream：SSE 订阅（断点续读）
 *
 * cookie 鉴权：user_id 取当前登录用户。x-user-id 透传头已废弃——无签名、空值放行。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { ThreadServiceError, createSseStream } from '@deerflow-harness';
import type { RunStatus, ThreadStatus } from '@deerflow-harness';
import type { ApiRouteHandler } from '@/backend/http';
import { jsonError } from '@/backend/http';
import { guardedStream } from '@/backend/services/run-stream-guard';
import {
  createThreadSchema,
  getThreadQuerySchema,
  listQuerySchema,
  runStreamQuerySchema,
  submitRunSchema,
} from '@/backend/validation/schemas';
import { getRunStore, getThreadService } from '@/backend/wiring';

export const list: ApiRouteHandler<undefined, z.infer<typeof listQuerySchema>> = async ({
  user,
  query,
}) => {
  const service = await getThreadService();
  const list = await service.listThreads({
    user_id: user!.id,
    limit: query.limit,
    offset: query.offset,
    status: query.status as ThreadStatus | undefined,
  });
  return NextResponse.json({ data: list }, { status: 200 });
};

export const create: ApiRouteHandler<z.infer<typeof createThreadSchema>, undefined> = async ({
  user,
  body,
}) => {
  const service = await getThreadService();
  const { thread_id } = await service.createThread({
    thread_id: body.thread_id,
    user_id: user!.id,
    assistant_id: body.assistant_id,
    display_name: body.display_name,
    metadata: body.metadata,
  });
  return NextResponse.json({ thread_id }, { status: 201 });
};

export const get: ApiRouteHandler<undefined, z.infer<typeof getThreadQuerySchema>> = async ({
  user,
  query,
  params,
}) => {
  const service = await getThreadService();
  const result = await service.getThread({
    thread_id: params.threadId,
    user_id: user!.id,
    includeCheckpoint: query.include === 'checkpoint',
  });
  if (!result) return jsonError('NOT_FOUND', 'not found', 404);
  return NextResponse.json(result, { status: 200 });
};

export const deleteThread: ApiRouteHandler<undefined, undefined> = async ({ user, params }) => {
  const service = await getThreadService();
  await service.deleteThread({
    thread_id: params.threadId,
    user_id: user!.id,
  });
  return NextResponse.json({ ok: true }, { status: 200 });
};

export const submitRun: ApiRouteHandler<z.infer<typeof submitRunSchema>, undefined> = async ({
  user,
  body,
  params,
}) => {
  const service = await getThreadService();
  const { run_id } = await service.submitRun({
    thread_id: params.threadId,
    user_id: user!.id,
    input: body.input,
    metadata: body.metadata,
  });
  return NextResponse.json({ run_id }, { status: 202 });
};

export const listRuns: ApiRouteHandler<undefined, z.infer<typeof listQuerySchema>> = async ({
  user,
  query,
  params,
}) => {
  const service = await getThreadService();
  const thread = await service.getThread({ thread_id: params.threadId, user_id: user!.id });
  if (!thread) return jsonError('NOT_FOUND', 'not found', 404);
  // 归属已在上一步经 service.getThread 校验；列表本身复用同一个 PgRunRepository 轻量直读
  const data = await getRunStore().listByThread(params.threadId, {
    limit: query.limit,
    offset: query.offset,
    status: query.status as RunStatus | undefined,
  });
  return NextResponse.json({ data }, { status: 200 });
};

/**
 * threads/[threadId]/runs/[runId]/stream：SSE 订阅（断点续读）——客户端 SSE 连接
 * 中断后凭 last-event-id 重连，只交付游标之后的事件：START 不重、已收事件不重、
 * END 至多一次。
 *
 * 与 v2 路由响应同形（text/event-stream，`id: <游标>\ndata: <json>\n\n`）。
 *
 * 收尾语义（run-stream-guard）：事件流不以 END 收尾时按 runs 终态 / owner 存活
 * 探测补发 ERROR + END，重连请求不悬挂。
 */

export const streamRun: ApiRouteHandler<undefined, z.infer<typeof runStreamQuerySchema>> = async ({
  params,
  query,
  user,
  request,
}) => {
  // 归属校验：不存在的 run 与别人的 run 一律 404，不泄露存在性
  const runs = getRunStore();
  const run = await runs.get(params.runId);
  if (!run || run.thread_id !== params.threadId || (run.user_id ?? null) !== (user?.id ?? null)) {
    throw new ThreadServiceError(`run not found: ${params.runId}`, 'NOT_FOUND');
  }

  const service = await getThreadService();
  const subscription = service.subscribe({
    thread_id: params.threadId,
    run_id: params.runId,
    fromEventId: query['last-event-id'],
  });

  const stream = createSseStream(request, guardedStream(subscription, runs, params.runId));

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
};

export const threadsController = {
  list,
  create,
  get,
  deleteThread,
  submitRun,
  listRuns,
  streamRun,
};
