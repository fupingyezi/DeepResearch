/**
 * 全部路由 body/query 的 zod schema（单一出处）。
 *
 * 约定：
 * - configuration 等宽松字段不用 .strict()（现状允许 [k: string]: unknown）
 * - 默认值不在这里施加（category→'context'、confidence→0.6 等由 service 层负责），
 *   schema 只校验形状与边界
 *
 * 各域 schema 随重构阶段 F 逐个补入。
 */

import { z } from 'zod';

/** UUID 字符串：sessionId / fileId / 路径参数共用的基础 schema。 */
export const uuidSchema = z.string().uuid();

/** conversations 域：rename / delete / cancel 共用的 sessionId-only body。 */
export const sessionIdBodySchema = z.object({
  sessionId: z.string().min(1),
});

/** conversations 域：重命名会话。 */
export const updateSessionBodySchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().min(1),
});

/** files 域：删除文件。 */
export const fileIdBodySchema = z.object({
  fileId: z.string().min(1),
});

// ---- v3/chat ----

export const chatContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('file'), fileId: z.string().min(1) }),
  z.object({ type: z.literal('image'), fileId: z.string().min(1) }),
]);

export type ChatContentBlock = z.infer<typeof chatContentBlockSchema>;

/**
 * v3/chat 请求体。
 *
 * - configuration 不用 .strict()：历史协议允许任意额外键，这里只约束已知字段形状
 * - contents 至少要有一个非空 text block（无 text 的纯文件请求模型无从作答）
 */
export const chatStreamBodySchema = z.object({
  sessionId: uuidSchema.optional(),
  configuration: z.record(z.string(), z.unknown()).nullable().optional(),
  message: z.object({
    contents: z
      .array(chatContentBlockSchema)
      .min(1)
      .refine((contents) => contents.some((b) => b.type === 'text' && b.text.trim().length > 0), {
        message: 'message.contents must contain at least one non-empty text block',
      }),
  }),
  stream: z.boolean().optional(),
  operation: z.enum(['resume', 'recall', 'reEditCall']).optional(),
});

export type ChatStreamBody = z.infer<typeof chatStreamBodySchema>;

// ---- memory ----

/**
 * facts：新建 fact。
 * content 必填非空；category / confidence 只约束类型，合法值与默认值
 * （'context' / 0.6）由 service 层施加——现状行为是非法值静默回落默认，
 * 这里保持（状态码零变化）。
 */
export const createMemoryFactSchema = z.object({
  content: z.string().trim().min(1),
  category: z.string().optional(),
  confidence: z.number().optional(),
});

/** facts：更新 fact。全部可选；content 出现时必须非空（现状：空 content → 400）。 */
export const updateMemoryFactSchema = z.object({
  content: z.string().trim().min(1).optional(),
  category: z.string().optional(),
  confidence: z.number().optional(),
});

/** mode：记忆注入模式（严格字面量，拼错即 400 而非静默回落）。 */
export const setMemoryModeSchema = z.object({
  mode: z.enum(['inject', 'retrieve']),
});

/** retrieve：检索预览 query（?q=）。 */
export const retrievePreviewSchema = z.object({
  q: z.string().trim().min(1),
});

// ---- model-keys ----

/** model-keys：保存 / 覆盖某 provider 的 Key（provider 白名单在 service 层）。 */
export const putModelKeySchema = z.object({
  provider: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
});

/** model-keys：设置当前选用模型预设（预设存在性在 service 层校验）。 */
export const patchSelectedModelSchema = z.object({
  selectedModel: z.string().trim().min(1),
});

// ---- mcp / skills（extensions） ----

/**
 * mcp：新增/更新 server。config 的详细形状由 harness 的
 * mcpServerConfigSchema 在 service 层校验（单一出处），这里只要求是个对象。
 */
export const upsertMcpServerSchema = z.object({
  name: z.string().trim().min(1),
  config: z.record(z.string(), z.unknown()),
});

/** mcp/skills：切换启用状态。 */
export const patchEnabledSchema = z.object({
  enabled: z.boolean(),
});

/** skills：新建自定义 skill（frontmatter 等校验在 harness loader）。 */
export const createSkillSchema = z.object({
  name: z.string().trim().min(1),
  content: z.string().min(1),
});

// ---- prompt/enhance ----

/** prompt/enhance：输入非空且 ≤ 8000 字符（与现状一致）。 */
export const enhancePromptSchema = z.object({
  input: z.string().trim().min(1).max(8000),
});

// ---- threads（x-user-id 机制不变：鉴权头原样透传） ----

/** threads：创建线程。全部字段可选（缺省时 ThreadService 自动生成 thread_id）。 */
export const createThreadSchema = z.object({
  thread_id: z.string().optional(),
  assistant_id: z.string().optional(),
  display_name: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** threads：提交 run（input 必填非空；metadata 透传给 ThreadService）。 */
export const submitRunSchema = z.object({
  input: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---- auth ----

/**
 * 登录 / 注册 / 首启初始化共用的凭证 body。
 * 只要求非空字符串，**不**加 .email()——邮箱格式错误现在走 401 而不是 400，
 * 收紧会改变现状行为。
 */
export const credentialsSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

/** 修改密码：current_password / new_password 必填，new_email 可选。 */
export const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(1),
  new_email: z.string().optional(),
});

// ---- 查询参数（统一请求管线 query 槽） ----

/** 重复 query key 折叠为首值：对齐 searchParams.get 语义，防数组把合法请求打成 400。 */
const firstValue = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

/**
 * threads / runs 分页查询。严格复刻现状 `Number(searchParams.get(...))` 语义：
 * 缺省 → limit 50 / offset 0；NaN / Infinity → 回落默认；空串 → 0；负数透传。
 * 非法值一律回落而非 400（现状如此，收紧会改状态码）。
 */
export const listQuerySchema = z.object({
  limit: z.preprocess(firstValue, z.coerce.number().finite().catch(50)),
  offset: z.preprocess(firstValue, z.coerce.number().finite().catch(0)),
  status: z.preprocess(firstValue, z.string().optional()),
  // ↑ 不能 z.enum(ThreadStatus/RunStatus)：未知值现状走 DB 过滤返回 200 空列表，收紧会 400。
});

/** conversations/history：sessionId 必填非空。不用 uuidSchema——非 UUID 现状返回 200 空结果。 */
export const historyQuerySchema = z.object({
  sessionId: z.string().min(1),
});

/** threads/[threadId] GET：include=checkpoint 才取 checkpoint，其余值/缺失一律不取。 */
export const getThreadQuerySchema = z.object({
  include: z.enum(['checkpoint']).optional().catch(undefined),
});

/** sandbox/stats：stats 字符串透传（handler 判 stats !== '0'，缺省即 true）。 */
export const sandboxStatsQuerySchema = z.object({
  stats: z.preprocess(firstValue, z.string().optional()),
});
