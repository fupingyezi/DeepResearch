/**
 * v2 统一 API 路由
 *
 * 通过 DeerFlowClient.stream() 处理所有请求，
 * 输出统一 AgentEvent 格式的 SSE 流。
 */

import { NextRequest, NextResponse } from 'next/server';
import { DeerFlowClient, createSseStream } from '@/deerflow-harness';

/**
 * 单例 DeerFlowClient
 * 懒加载 + 配置键缓存，全局只创建一次
 */
let client: DeerFlowClient | null = null;

function getClient(): DeerFlowClient {
  if (!client) {
    client = new DeerFlowClient(
      {
        modelName: process.env.OPENAI_MODEL_NAME ?? 'qwen3.6-plus',
        apiKey: process.env.OPENAI_QWEN_API_KEY,
        baseUrl: process.env.OPENAI_QWEN_BASE_URL,
      },
      { subagentEnabled: true },
    );
  }
  return client;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { input, sessionId } = body;

    if (!input) {
      return NextResponse.json({ error: 'Missing input' }, { status: 400 });
    }

    const deerflow = getClient();
    const eventStream = deerflow.stream(input, sessionId, {
      sessionId,
    });

    const readableStream = createSseStream(request, eventStream);

    return new Response(readableStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error: any) {
    console.error('Error in v2 chat API:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
