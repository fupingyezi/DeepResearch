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
