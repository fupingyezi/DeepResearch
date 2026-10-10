/**
 * /api/v3/chat —— 单一聊天入口
 *
 * 协议（请求体）：
 *   POST application/json
 *   {
 *     "sessionId"?: string,                       // 缺省 = 新建会话；存在 = 已有会话
 *     "configuration"?: {
 *       "model"?: { "value"?: string },           // 显式指定模型预设；缺省回落用户落库的选择
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
 * 薄路由：管线（鉴权 / zod 校验）→ chat-service（prepare 全序列 / submit / streamEvents）。
 * SSE 前置失败为 JSON（预检元组经 preflightError 统一为 {code,message}），成功路径
 * `new Response(createSseStream(request, events))`，X-Run-Id / X-Thread-Id 在此组装。
 */

import { createSseStream } from '@/deerflow-harness';
import { preflightError, withApiHandler } from '@/server/http';
import { getChatService } from '@/server/services/chat-service';
import { chatStreamBodySchema } from '@/server/validation/schemas';

export { OPTIONS } from '@/server/http/preflight';

export const POST = withApiHandler(
  { body: chatStreamBodySchema },
  async ({ user, body, request }) => {
    const svc = getChatService();

    const prepared = await svc.prepare({ userId: user!.id, body });
    if (!prepared.ok) return preflightError(prepared.status, prepared.body);

    const submitted = await svc.submit(prepared.prepared);
    if (!submitted.ok) return preflightError(submitted.status, submitted.body);

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
  },
);
