/**
 * /api/v3/chat —— 单一聊天入口
 *
 * 协议（请求体）：
 *   POST application/json
 *   {
 *     "sessionId"?: string,                       // 缺省 = 新建会话；存在 = 已有会话
 *     "configuration"?: {
 *       "model"?: { "value"?: string },           // 替代旧的 metadata.modelKey
 *       "memoryEnabled"?: boolean                 // 单次请求覆盖服务级 memory 开关
 *     },
 *     "message": {
 *       "contents": Array<
 *         | { "type": "text",  "text": string }
 *         | { "type": "file",  "fileId": string }
 *         | { "type": "image", "fileId": string }
 *       >
 *     },
 *     "stream"?: true,
 *     "operation"?: "resume" | "recall" | "reEditCall"
 *   }
 *
 * Response：
 *   text/event-stream，载荷为 ClientAgentEvent。
 *
 * 薄路由：鉴权 → zod 校验 → chat-service（prepare 全序列 / submit / streamEvents）。
 * SSE 前置失败为 JSON（错误体形状由 chat-service 逐条保持），成功路径
 * `new Response(createSseStream(request, events))`，X-Run-Id / X-Thread-Id 在此组装。
 */

import { NextRequest } from 'next/server';

import { createSseStream } from '@/deerflow-harness';
import { getCurrentUser } from '@/server/http';
import { getChatService } from '@/server/services/chat-service';
import { parseJsonBody } from '@/server/validation';
import { chatStreamBodySchema } from '@/server/validation/schemas';

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser(request);
  if (!currentUser) {
    return jsonResponse(401, { error: 'Not authenticated' });
  }

  const parsed = await parseJsonBody(request, chatStreamBodySchema);
  if (!parsed.ok) return parsed.response;

  const svc = getChatService();

  const prepared = await svc.prepare({ userId: currentUser.id, body: parsed.data });
  if (!prepared.ok) return jsonResponse(prepared.status, prepared.body);

  const submitted = await svc.submit(prepared.prepared);
  if (!submitted.ok) return jsonResponse(submitted.status, submitted.body);

  const stream = createSseStream(request, svc.streamEvents(prepared.prepared, submitted.runId));
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Run-Id': submitted.runId,
      'X-Thread-Id': prepared.prepared.threadId,
    },
  });
}
