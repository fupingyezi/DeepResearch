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
      modelName: modelName ?? process.env.OPENAI_MODEL_NAME ?? 'qwen3.7-max',
      apiKey: process.env.OPENAI_QWEN_API_KEY,
      baseUrl: process.env.OPENAI_QWEN_BASE_URL,
      // memory updater 是 afterAgent 后台异步任务，不需要 token streaming。
      // 关键：若开启 streaming，本次后台 invoke 会复用主请求 SSE 链上的
      // callback handler，主请求 ReadableStream 已关闭后会抛
      // `ERR_INVALID_STATE: Controller is already closed`。
      streaming: false,
      // memory updater 输出是结构化 JSON（user/history/facts 多段聚合），
      // 在长对话历史下 4096 tokens 很容易被截断 → JSON 解析失败、整次更新被丢弃。
      // 给一个明显更宽的上限；真正写入 storage 时还会按 maxFacts 收敛，所以
      // 不会因为放宽 token 上限而无限膨胀。
      maxTokens: 8192,
      // 这一类生成型 JSON 任务对采样多样性不敏感，反而需要更确定的输出，
      // 降低 temperature/topP 也能减小被截断时输出半截无效 JSON 的概率。
      temperature: 0.2,
      topP: 0.8,
    }),
  );
  memoryFactoryRegistered = true;
}

async function build(): Promise<ThreadService> {
  const { saver: checkpointer } = await makeCheckpointer({ kind: 'postgres' });

  ensureMemoryModelFactory();

  const client = new DeerFlowClient(
    {
      modelName: process.env.OPENAI_MODEL_NAME ?? 'qwen3.7-max',
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
