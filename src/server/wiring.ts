/**
 * threadService 全局单例
 *
 * 支持两种模式：
 * 1. 基础单例模式（缓存 DeerFlowClient）
 * 2. 动态模型模式：通过 body.configuration.model.value 在请求时传递
 */

import {
  DeerFlowClient,
  InMemoryRunEventBus,
  InMemoryRunRegistry,
  PgRunStore,
  RedisEventBus,
  RedisRunRegistry,
  PgThreadMetaStore,
  buildThreadConfig,
  createChatModel,
  createThreadService,
  makeCheckpointer,
  EMBEDDING_BATCH_LIMIT,
  getMemoryConfig,
  maxImageBytesFromEnv,
  PgMemoryStorage,
  setMemoryConfig,
  setMemoryEmbeddingsFactory,
  setMemoryModelFactory,
  setMemoryRerankerFactory,
  setMemoryStorage,
  setParentHistoryProvider,
  setThreadImageFetcher,
  setTitleModelFactory,
  type MemorySqlExecutor,
  type ThreadService,
  type ModelConfig,
} from '@/deerflow-harness';
import { OpenAIEmbeddings } from '@langchain/openai';
import { getClient, initialMemoryDb, query } from '@/lib/db';
import { getFile, getMimeType } from '@/lib/storage';
import { createZhipuReranker } from '@/lib/zhipu-rerank';
import {
  buildModelConfigFromPreset,
  resolveModelConfig,
  MODEL_PRESETS,
  type ModelPresetName,
} from '@/config/models';

// dev 下用 globalThis 兜住单例：Next.js 会按路由分别编译、热更时重新求值模块，
// 纯模块级变量会分裂出多份实例 —— 各路由看到各自的 activeRuns / StreamBridge，
// 于是「删除对话时取消在跑的 run」「停止按钮取消 run」「按 run 订阅事件流」这类
// 跨路由操作会静默失效（请求落在没有那个 run 的实例上）。生产单次打包无此问题，
// 与 lib/db 的 pg pool 同一套做法。
const globalForService = globalThis as unknown as {
  __threadService?: ThreadService;
  __threadServiceInit?: Promise<ThreadService>;
};

let service: ThreadService | null =
  process.env.NODE_ENV === 'production' ? null : (globalForService.__threadService ?? null);
let initPromise: Promise<ThreadService> | null =
  process.env.NODE_ENV === 'production' ? null : (globalForService.__threadServiceInit ?? null);
let memoryFactoryRegistered = false;
let titleFactoryRegistered = false;
let embeddingsFactoryRegistered = false;
let rerankerFactoryRegistered = false;
let imageFetcherRegistered = false;
let parentHistoryProviderRegistered = false;

/**
 * 把 chat model 工厂注入给 memory 子系统（updater）。
 * 只需注入一次；若 factory 未注入，updater 会跳过 LLM 提炼直接返回 false。
 */
function ensureMemoryModelFactory(): void {
  if (memoryFactoryRegistered) return;
  setMemoryModelFactory((modelName) => {
    let base: ModelConfig;
    if (modelName && MODEL_PRESETS[modelName as ModelPresetName]) {
      base = buildModelConfigFromPreset(modelName as ModelPresetName);
    } else if (modelName) {
      const fallback = resolveModelConfig();
      base = { ...fallback, modelName };
    } else {
      base = resolveModelConfig();
    }
    return createChatModel({
      ...base,
      streaming: false,
      // 16384 而非 8192：记忆抽取要输出「更新后的各 section + facts JSON」，而思考模型的
      // reasoning 计入 completion_tokens。实测 8192 时输出次均 7,548 token 已顶到上限，
      // 10 次更新里 4 次失败（2 次空响应、2 次 JSON 被截断），**静默丢掉事实**。
      // 上限只是预算、不是开销：模型用不到就不会生成。
      maxTokens: 16384,
      temperature: 0.2,
      topP: 0.8,
    });
  });
  memoryFactoryRegistered = true;
}

/**
 * 把 chat model 工厂注入给 titleMiddleware / 提示词增强（共用同一条副链路入口）。
 * 工厂第二参为采样参数覆盖：标题走缺省（64/0.3），提示词增强传更大 maxTokens。
 * 导出供 /api/prompt/enhance 在 threadService 尚未初始化时也能确保工厂已注册。
 */
export function ensureTitleModelFactory(): void {
  if (titleFactoryRegistered) return;
  setTitleModelFactory((modelName, options) => {
    let base: ModelConfig;
    if (modelName && MODEL_PRESETS[modelName as ModelPresetName]) {
      base = buildModelConfigFromPreset(modelName as ModelPresetName);
    } else if (modelName) {
      const fallback = resolveModelConfig();
      base = { ...fallback, modelName };
    } else {
      base = resolveModelConfig();
    }
    return createChatModel({
      ...base,
      streaming: false,
      maxTokens: options?.maxTokens ?? 64,
      temperature: options?.temperature ?? 0.3,
      topP: options?.topP ?? 0.8,
    });
  });
  titleFactoryRegistered = true;
}

/**
 * 把智谱 embedding-3 客户端注入给 memory 子系统（语义检索）。
 * 无 DEERFLOW_EMBEDDING_API_KEY / ZHIPU_API_KEY 时工厂返回 null，
 * 检索自动退回关键词词面打分（不报错）。导出供测试与提前初始化使用。
 */
export function ensureMemoryEmbeddingsFactory(): void {
  if (embeddingsFactoryRegistered) return;
  embeddingsFactoryRegistered = true;
  setMemoryEmbeddingsFactory(() => {
    const apiKey = process.env.DEERFLOW_EMBEDDING_API_KEY || process.env.ZHIPU_API_KEY;
    if (!apiKey) return null;
    const { embeddingDimensions } = getMemoryConfig();
    return new OpenAIEmbeddings({
      model: process.env.DEERFLOW_EMBEDDING_MODEL || 'embedding-3',
      apiKey,
      dimensions: embeddingDimensions,
      batchSize: EMBEDDING_BATCH_LIMIT, // 智谱单请求 64 条上限
      // 必须显式指定 'float'：OpenAI SDK 在调用方未指定时会把 encoding_format 默认成
      // 'base64' 并按 base64 解码响应（toFloat32Array），而智谱**忽略**该参数、仍返回
      // float 数组 —— 结果是数组被当字节流重解释，得到 256 个（原 1024）无意义数值，
      // 余弦算成 NaN，语义检索静默退回词面检索。指定后 SDK 原样返回，实测维度与语义均正确。
      encodingFormat: 'float',
      configuration: {
        baseURL: process.env.DEERFLOW_EMBEDDING_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
      },
    });
  });
  // env 维度覆盖合并进 MemoryConfig 单例（clamp 256..2048）
  const dims = Number(process.env.DEERFLOW_EMBEDDING_DIMENSIONS);
  if (Number.isFinite(dims) && dims > 0) {
    setMemoryConfig({
      ...getMemoryConfig(),
      embeddingDimensions: Math.min(2048, Math.max(256, Math.round(dims))),
    });
  }
}

/**
 * 把智谱 rerank 客户端注入给 memory 子系统（RAG 精排）。
 * DEERFLOW_RERANK_ENABLED='0' 显式关：工厂返回 null 并把 config 关掉（检索保持 RRF 序）；
 * 无 DEERFLOW_RERANK_API_KEY / ZHIPU_API_KEY 时工厂返回 null（同 embedding 口径，
 * 检索保持 RRF 序继续）。导出供 memory-service 预览接口在 threadService 尚未
 * 初始化时也能提前注册。
 */
export function ensureMemoryRerankerFactory(): void {
  if (rerankerFactoryRegistered) return;
  rerankerFactoryRegistered = true;
  if (process.env.DEERFLOW_RERANK_ENABLED === '0') {
    setMemoryConfig({ ...getMemoryConfig(), rerankEnabled: false });
    setMemoryRerankerFactory(() => null);
    return;
  }
  setMemoryRerankerFactory(() => {
    const apiKey = process.env.DEERFLOW_RERANK_API_KEY || process.env.ZHIPU_API_KEY;
    if (!apiKey) return null;
    return createZhipuReranker({
      apiKey,
      model: process.env.DEERFLOW_RERANK_MODEL || 'rerank',
      baseUrl: process.env.DEERFLOW_RERANK_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
    });
  });
}

/**
 * 把 lib/db 的连接池包装成 harness 的最小 SQL 接口（query + transaction），
 * 供 PgMemoryStorage 使用。transaction 语义：fn 抛错 → ROLLBACK 后原样上抛；
 * 不支持嵌套（记忆存储不嵌套事务，显式抛错防误用）。
 */
function makeMemorySqlExecutor(): MemorySqlExecutor {
  const txExecutor = (client: Awaited<ReturnType<typeof getClient>>): MemorySqlExecutor => ({
    query: async (text, params) => {
      const result = await client.query(text, (params ?? []) as any[]);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
    },
    transaction: async () => {
      throw new Error('[wiring] nested memory transactions are not supported');
    },
  });
  return {
    query: async (text, params) => {
      const result = await query(text, (params ?? []) as any[]);
      return {
        rows: (result?.rows ?? []) as Record<string, unknown>[],
        rowCount: result?.rowCount ?? null,
      };
    },
    transaction: async (fn) => {
      const client = await getClient();
      try {
        await client.query('BEGIN');
        const out = await fn(txExecutor(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

const globalForMemoryStorage = globalThis as unknown as {
  __memoryStorageInit?: Promise<void>;
};

let memoryStorageReady = false;

/**
 * 记忆存储后端装配：pgvector 可用（initialMemoryDb 成功）→ 切换 PgMemoryStorage；
 * 否则 warnOnce 保留默认的 FileMemoryStorage（记忆功能不损，仅失去 PG 收益）。
 * 幂等 + dev 下 globalThis 缓存 init promise（HMR 重新求值模块不重复建连）。
 * 导出供 memory-service 在 threadService 尚未初始化时也能提前装配，
 * 消除「先写了文件、后注册 PG」的夹缝窗口。
 */
export async function ensureMemoryStorage(): Promise<void> {
  if (memoryStorageReady) return;
  let p: Promise<void> | null =
    process.env.NODE_ENV === 'production'
      ? null
      : (globalForMemoryStorage.__memoryStorageInit ?? null);
  if (!p) {
    p = (async () => {
      // 先确保 embedding 工厂注册：env 的维度覆盖（DEERFLOW_EMBEDDING_DIMENSIONS）
      // 在其中合入 MemoryConfig，pgvector 列维度必须按覆盖后的值初始化
      ensureMemoryEmbeddingsFactory();
      const { embeddingDimensions } = getMemoryConfig();
      const init = await initialMemoryDb(embeddingDimensions);
      if (init.ok) {
        setMemoryStorage(new PgMemoryStorage(makeMemorySqlExecutor()));
      } else {
        console.warn(`[wiring] pgvector unavailable, keeping file-backed memory: ${init.reason}`);
      }
      memoryStorageReady = true;
    })();
    if (process.env.NODE_ENV !== 'production') globalForMemoryStorage.__memoryStorageInit = p;
  }
  await p;
}

/**
 * 把「MinIO 图片字节读取器」注入给 vision 子系统（多模态 HumanMessage 构造）。
 *
 * 依赖方向约束：harness 层不反向依赖 app 层（MinIO 客户端在 src/lib/storage），
 * 故由 app 层注入，模式对齐 setMemoryModelFactory / setTitleModelFactory。
 * 未注册 / minioKey 缺失 / 读取失败 → 返回 null，构造侧自动把该图降级为文本说明。
 */
function ensureThreadImageFetcher(): void {
  if (imageFetcherRegistered) return;
  imageFetcherRegistered = true;
  setThreadImageFetcher(async (ref) => {
    if (!ref.minioKey) return null;
    const maxBytes = maxImageBytesFromEnv();
    // DB 已知字节数且超限 → 连拉取都省掉（上传上限 50MB，vision 默认 5MB）
    if (typeof ref.sizeBytes === 'number' && ref.sizeBytes > maxBytes) return null;
    try {
      const stream = await getFile(ref.minioKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) return null;
      // mimeType 优先用 DB 值（只有 image/* 才可信，否则智谱会 400）
      const mimeType =
        ref.mimeType && ref.mimeType.startsWith('image/')
          ? ref.mimeType
          : getMimeType((ref.filename ?? '').split('.').pop() ?? '');
      return { base64: buffer.toString('base64'), mimeType };
    } catch (e) {
      console.warn('[threadImageFetcher] load failed:', ref.fileId, e);
      return null;
    }
  });
}

/**
 * 把「父线程 checkpoint 读取器」注入给 subagent 子系统（父历史上下文注入）。
 *
 * 只读 getTuple（父线程 messages 通道），不写任何状态；剪枝在 harness 侧
 * （subagents/parent-history.ts）完成。读取失败静默回落 undefined，
 * 子 agent 不带父历史运行，不阻断 task。
 */
function ensureParentHistoryProvider(
  checkpointer: Awaited<ReturnType<typeof makeCheckpointer>>['saver'],
): void {
  if (parentHistoryProviderRegistered) return;
  parentHistoryProviderRegistered = true;
  setParentHistoryProvider(async (threadId) => {
    try {
      const getTuple: unknown = checkpointer?.getTuple;
      if (typeof getTuple !== 'function') return undefined;
      const tuple = (await (getTuple as (config: unknown) => Promise<unknown>).call(
        checkpointer,
        buildThreadConfig(threadId),
      )) as { checkpoint?: { channel_values?: Record<string, unknown> } } | undefined;
      const messages = tuple?.checkpoint?.channel_values?.messages;
      return Array.isArray(messages) ? messages : undefined;
    } catch {
      return undefined;
    }
  });
}

/**
 * 默认 ModelConfig：走 resolveModelConfig() 的默认 preset；apiKey/baseUrl
 * 由 buildModelConfigFromPreset 按 provider 注入。
 */
function getDefaultModelConfig(): ModelConfig {
  return resolveModelConfig();
}

async function build(): Promise<ThreadService> {
  const { saver: checkpointer } = await makeCheckpointer({ kind: 'postgres' });

  // 记忆存储后端：pgvector 就绪则切 PG（含旧文件懒迁移），否则保留文件后端
  await ensureMemoryStorage();
  ensureMemoryModelFactory();
  ensureTitleModelFactory();
  ensureMemoryEmbeddingsFactory();
  ensureMemoryRerankerFactory();
  ensureThreadImageFetcher();
  ensureParentHistoryProvider(checkpointer);

  const defaultModelConfig = getDefaultModelConfig();

  // 服务级默认 features：
  //   - memoryEnabled:    true  → 长期记忆默认开启；可被 metadata 覆盖。
  //   - autoTitleEnabled: true  → 首轮后异步生成会话标题（替代占位 "New thread"）。
  //   - threadDataEnabled: true → 装载本会话上传文件到 state（基础设施）。
  //   - uploadsEnabled:   true  → 把上传文件以 SystemMessage 注入 prompt 上下文。
  //   - sandboxEnabled:   true  → 获取沙箱并注入文件工具集（bash 默认禁用，需 env 开启）。
  //   - summarizationEnabled: true → 历史触达阈值（12000 tokens）时自动摘要旧消息，
  //                                保留近 8 条；会额外调用一次 LLM。
  //   - guardrailEnabled: true  → 规则式护栏默认开启（仅告警不拦截）。
  //   - todoEnabled:      true  → 注入 write_todos 工具，清单经 todo_update 事件下发前端。
  // 单次请求可通过 body.configuration.<key> 显式覆盖（见 v3/chat route.ts）。
  const sharedClientOptions = {
    agentName: 'lead' as const,
    memoryEnabled: true,
    autoTitleEnabled: true,
    threadDataEnabled: true,
    uploadsEnabled: true,
    sandboxEnabled: true,
    summarizationEnabled: true,
    guardrailEnabled: true,
    todoEnabled: true,
    checkpointer,
  };

  const client = new DeerFlowClient(defaultModelConfig, sharedClientOptions);

  // 按模型配置签名缓存 client，供 submitRun 在单次请求切换模型时复用（避免每请求新建丢失 agentCache）。
  //
  // 缓存键必须是**完整 modelConfig 的签名**而不是 modelName：client 在构造时固化
  // modelConfig（apiKey / baseUrl / supportsVision 都在里面），按名字缓存意味着
  // ① 两个用户用同一模型会共用第一个用户的 client（**连带他的 API Key**）；
  // ② 配置变化（如给预设补 supportsVision）后，同进程内的旧 client 永远不会刷新
  //    —— dev 下 globalThis 单例跨 HMR 存活，改完预设不重启 dev 就会出现
  //    「远端生效、本地不生效」的假象（实测踩过）。
  const clientByModel = new Map<string, DeerFlowClient>();
  const createClientForModel = (modelConfig: ModelConfig): DeerFlowClient => {
    const signature = JSON.stringify(modelConfig);
    const cached = clientByModel.get(signature);
    if (cached) return cached;
    const next = new DeerFlowClient(modelConfig, sharedClientOptions);
    clientByModel.set(signature, next);
    return next;
  };

  // REDIS_URL 配置时用跨进程登记表（连接失败自降级进程内、只告警一次），
  // 未配置直接用进程内实现：装配侧是切换本地 / 跨进程实现的唯一换芯点。
  // 事件总线同口径：Redis Stream 回放 / 断点续读，否则进程内 buffer 回放。
  const registry = process.env.REDIS_URL ? new RedisRunRegistry() : new InMemoryRunRegistry();
  const eventBus = process.env.REDIS_URL ? new RedisEventBus() : new InMemoryRunEventBus();

  return createThreadService({
    client,
    checkpointer,
    threads: new PgThreadMetaStore(),
    runs: new PgRunStore(),
    createClientForModel,
    registry,
    eventBus,
  });
}

export async function getThreadService(): Promise<ThreadService> {
  if (service) return service;
  if (!initPromise) {
    initPromise = build().then((s) => {
      service = s;
      if (process.env.NODE_ENV !== 'production') globalForService.__threadService = s;
      return s;
    });
    if (process.env.NODE_ENV !== 'production') globalForService.__threadServiceInit = initPromise;
  }
  return initPromise;
}

/**
 * runs 表的轻量直读入口（threads/[threadId]/runs GET 与 chat-service 共用）。
 *
 * PgRunStore 无状态（连接池在 @/lib/db 的 globalThis 上），模块级懒单例即可，
 * 不需要像 getThreadService 那样挂 globalThis——没有跨路由共享的可变状态。
 */
let runStore: PgRunStore | null = null;

export function getRunStore(): PgRunStore {
  if (!runStore) runStore = new PgRunStore();
  return runStore;
}
