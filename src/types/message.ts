import z from 'zod';

export const tokenUsageSchema = z.object({
  totalTokensIn: z.number(),
  totalTokensOut: z.number(),
  totalCacheWrites: z.number().optional(),
  totalCacheReads: z.number().optional(),
  totalCost: z.number(),
  contextTokens: z.number(),
});

export type TokenUsage = z.infer<typeof tokenUsageSchema>; // 令牌使用情况统计
