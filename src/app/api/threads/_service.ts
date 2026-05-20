/**
 * threadService 全局单例
 *
 * 与 v2 路由的 `getClient()` 同模式：懒加载 + 进程内复用。
 * 所有 v3 路由通过 `getThreadService()` 获取同一份装配实例。
 */

import {
  DeerFlowClient,
  PgRunStore,
  PgThreadMetaStore,
  createThreadService,
  makeCheckpointer,
  type ThreadService,
} from '@/deerflow-harness';

let service: ThreadService | null = null;
let initPromise: Promise<ThreadService> | null = null;

async function build(): Promise<ThreadService> {
  const { saver: checkpointer } = await makeCheckpointer({ kind: 'postgres' });

  const client = new DeerFlowClient(
    {
      modelName: process.env.OPENAI_MODEL_NAME ?? 'qwen3.6-plus',
      apiKey: process.env.OPENAI_QWEN_API_KEY,
      baseUrl: process.env.OPENAI_QWEN_BASE_URL,
    },
    {
      subagentEnabled: true,
      checkpointer,
    },
  );

  return createThreadService({
    client,
    checkpointer,
    threads: new PgThreadMetaStore(),
    runs: new PgRunStore(),
  });
}

export async function getThreadService(): Promise<ThreadService> {
  if (service) return service;
  if (!initPromise) {
    initPromise = build().then((s) => {
      service = s;
      return s;
    });
  }
  return initPromise;
}
