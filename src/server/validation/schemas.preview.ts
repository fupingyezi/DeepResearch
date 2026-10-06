/**
 * 记忆「检索效果预览」接口的请求 schema（*.preview.ts：仅调试/观察接口使用）。
 */

import { z } from 'zod';

/** retrieve：检索预览 query（?q=）。 */
export const retrievePreviewSchema = z.object({
  q: z.string().trim().min(1),
});
