/**
 * 多模态 content 的工具函数。
 *
 * 为什么单独成文件而不复用 memory 的 extractMessageText：
 * - 那个收的是 **message** 而非 content，调用处要写成 `extractMessageText({ content })`，语义倒错；
 * - 它是 memory 域内部工具，client / view_image 工具直接引用会形成横向耦合；
 * - join 分隔符语义不同：memory 用单空格（语义检索拼词），SSE 展示用换行更合适。
 */

/**
 * 只取 content 中的 text blocks 拼接（string content 原样返回）。
 *
 * 用途：多模态 ToolMessage（如 view_image 返回的 image_url blocks）转内部事件时，
 * 必须剥离 base64 —— 否则一次 tool_result 就能把 SSE 事件与前端 parts-reducer 灌爆。
 */
export function extractContentTextBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (
      block &&
      typeof block === 'object' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('\n');
}
