import { createMiddleware } from 'langchain';

/**
 * ViewImageMiddleware（features.vision 启用）
 *
 * 职责（占位）：
 * - 处理 ThreadState.viewedImages：把图片消息转换为多模态 content 注入模型；
 * - 中间件可在处理后返回空对象 `{}` 触发 reducer 清空，避免重复消费。
 */
export const viewImageMiddleware = createMiddleware({
  name: 'ViewImageMiddleware',
});
