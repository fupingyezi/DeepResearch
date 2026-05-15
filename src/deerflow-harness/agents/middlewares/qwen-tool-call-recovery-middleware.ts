import { createMiddleware } from 'langchain';
import { AIMessage } from '@langchain/core/messages';

/**
 * QwenToolCallRecoveryMiddleware
 *
 * 在 model 调用出口观察并修复 Qwen/DashScope 返回的 AIMessage：
 * 当 `tool_calls` 为空但 `additional_kwargs.tool_calls` 有内容时，
 * 解析 raw payload 并回填到规范化字段。
 */

interface RawToolCall {
  id?: string;
  type?: string;
  index?: number;
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

export const qwenToolCallRecoveryMiddleware = createMiddleware({
  name: 'QwenToolCallRecoveryMiddleware',
  wrapModelCall: async (request, handler) => {
    const result = await handler(request);

    const msg: any = (result as any)?.message ?? result;

    if (msg && AIMessage.isInstance(msg)) {
      const structured = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const rawList = (msg.additional_kwargs?.tool_calls ?? []) as RawToolCall[];

      console.log('[QwenRecovery] model out', {
        contentLen: typeof msg.content === 'string' ? msg.content.length : -1,
        structuredCount: structured.length,
        rawCount: Array.isArray(rawList) ? rawList.length : 0,
        rawSample: Array.isArray(rawList) ? rawList[0] : undefined,
        addKwKeys: msg.additional_kwargs ? Object.keys(msg.additional_kwargs) : [],
      });

      if (structured.length === 0 && Array.isArray(rawList) && rawList.length > 0) {
        const recovered = rawList
          .filter((r) => r && typeof r === 'object')
          .map((r) => ({
            id: r.id ?? '',
            name: r.function?.name ?? 'unknown',
            args: parseArgs(r.function?.arguments),
            type: 'tool_call' as const,
          }));
        if (recovered.length > 0) {
          msg.tool_calls = recovered;
          console.warn(
            `[QwenRecovery] Recovered ${recovered.length} tool_call(s) from additional_kwargs`,
          );
        }
      }
    }

    return result;
  },
});
