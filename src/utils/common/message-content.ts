/**
 * LangChain MessageContent 文本提取
 *
 * 把 LangChain BaseMessage.content 归一化为纯文本字符串：
 * - string                                 → 原样返回
 * - Array<string | { text?: string; ... }> → 顺序拼接
 *   - 连续 string 块用 '' 紧贴拼接（视作同一段）
 *   - 遇到对象块时，先 flush 当前 string 段为一行，再追加对象的 text
 *   - 对象 block 的 text 字段类型必须是 string，其它类型忽略
 * - 其它类型（含 null/undefined） → '' 或 String(content)
 *
 * 取代 deerflow-harness/agents/memory/{updater,prompt}.ts 内重复的两份实现。
 */
export function extractMessageContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const pieces: string[] = [];
    let pending: string[] = [];

    const flush = () => {
      if (pending.length > 0) {
        pieces.push(pending.join(''));
        pending = [];
      }
    };

    for (const block of content) {
      if (typeof block === 'string') {
        pending.push(block);
      } else if (block && typeof block === 'object') {
        flush();
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') pieces.push(text);
      }
    }
    flush();
    return pieces.join('\n');
  }
  return content == null ? '' : String(content);
}
