import z from 'zod';

// ClineAsk - LLM请求用户交互或批准的消息类型
export const clineAsks = ['followup', 'command', 'tool']; // 所有可能的ask类型数组，包括followup、command、tool等
export const clineAskSchema = z.enum(clineAsks);
export type ClineAsk = z.infer<typeof clineAskSchema>; // 表示需要用户响应的消息类型

// ClineSay - 助手发送的不同类型消息
export const clineSays = ['text', 'error']; // 所有可能的say类型数组，包括text、error等
export const clineSaySchema = z.enum(clineSays);
export type ClineSay = z.infer<typeof clineSaySchema>; // 表示助手发送的消息类型

export const toolProgressStatusSchema = z.object({
  icon: z.string().optional(),
  text: z.string().optional(),
});

export type ToolProgressStatus = z.infer<typeof toolProgressStatusSchema>; // 工具进度状态，包含图标和文本

// 消息结构类型
export const clineMessageSchema = z.object({
  ts: z.number(),
  type: z.union([z.literal('ask'), z.literal('say')]),
  ask: clineAskSchema.optional(),
  say: clineSaySchema.optional(),
  text: z.string().optional(),
  images: z.array(z.string()).optional(),
  partial: z.boolean().optional(),
  reasoning: z.string().optional(),
  conversationHistoryIndex: z.number().optional(),
  checkpoint: z.record(z.string(), z.any()).optional(),
  progressStatus: toolProgressStatusSchema.optional(),
  isProtected: z.boolean().optional(),
  isAnswered: z.boolean().optional(),
});

export type ClineMessage = z.infer<typeof clineMessageSchema>; // 主要的消息类型，用于扩展和webview之间的通信，包含ts、type、ask/say等字段

export const tokenUsageSchema = z.object({
  totalTokensIn: z.number(),
  totalTokensOut: z.number(),
  totalCacheWrites: z.number().optional(),
  totalCacheReads: z.number().optional(),
  totalCost: z.number(),
  contextTokens: z.number(),
});

export type TokenUsage = z.infer<typeof tokenUsageSchema>; // 令牌使用情况统计

export const QueuedMessageSchema = z.object({
  timeStamp: z.string(),
  id: z.string(),
  text: z.string(),
  images: z.array(z.string().optional()),
});
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>; // 队列中的消息类型，包含时间戳、ID、文本和图片
