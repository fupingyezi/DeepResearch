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
  createChatModel,
  createThreadService,
  makeCheckpointer,
  setMemoryModelFactory,
  type ThreadService,
} from '@/deerflow-harness';

let service: ThreadService | null = null;
let initPromise: Promise<ThreadService> | null = null;
let memoryFactoryRegistered = false;

/**
 * 把 chat model 工厂注入给 memory 子系统（updater）。
 * 只需注入一次；若 factory 未注入，updater 会跳过 LLM 提炼直接返回 false。
 */
function ensureMemoryModelFactory(): void {
  if (memoryFactoryRegistered) return;
  setMemoryModelFactory((modelName) =>
    createChatModel({
      modelName: modelName ?? process.env.OPENAI_MODEL_NAME ?? 'qwen3.6-plus',
      apiKey: process.env.OPENAI_QWEN_API_KEY,
      baseUrl: process.env.OPENAI_QWEN_BASE_URL,
      // memory updater 是 afterAgent 后台异步任务，不需要 token streaming。
      // 关键：若开启 streaming，本次后台 invoke 会复用主请求 SSE 链上的
      // callback handler，主请求 ReadableStream 已关闭后会抛
      // `ERR_INVALID_STATE: Controller is already closed`。
      streaming: false,
    }),
  );
  memoryFactoryRegistered = true;
}

async function build(): Promise<ThreadService> {
  const { saver: checkpointer } = await makeCheckpointer({ kind: 'postgres' });

  ensureMemoryModelFactory();

  const client = new DeerFlowClient(
    {
      modelName: process.env.OPENAI_MODEL_NAME ?? 'qwen3.6-plus',
      apiKey: process.env.OPENAI_QWEN_API_KEY,
      baseUrl: process.env.OPENAI_QWEN_BASE_URL,
    },
    {
      agentName: 'lead',
      subagentEnabled: true,
      memoryEnabled: true,
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
