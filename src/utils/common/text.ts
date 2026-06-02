/**
 * 文本通用工具。
 */

/**
 * 取首句（中英标点都识别），并截断到 maxLen 字以内防止单行过长（默认 80）。
 */
export function firstSentence(text: string, maxLen = 80): string {
  const stripped = text.replace(/\s+/g, ' ').trim();
  const match = stripped.match(/^(.+?[。！？!?\.])/);
  const head = match ? match[1] : stripped;
  return head.length > maxLen ? `${head.slice(0, maxLen)}…` : head;
}
