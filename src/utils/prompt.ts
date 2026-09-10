/**
 * 提示词增强：调用 /api/prompt/enhance（复用标题生成的副链路小模型）。
 *
 * 成功返回增强后的文本；失败抛错，调用方自行降级（输入框保持原内容即可）。
 */

export async function enhancePrompt(input: string): Promise<string> {
  const res = await fetch('/api/prompt/enhance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ input }),
  });
  const data = (await res.json().catch(() => ({}))) as { enhanced?: unknown; message?: unknown };
  if (!res.ok || typeof data.enhanced !== 'string') {
    throw new Error(typeof data.message === 'string' ? data.message : 'Enhance failed');
  }
  return data.enhanced;
}
