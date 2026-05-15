import { createMiddleware } from 'langchain';
import { AIMessage } from '@langchain/core/messages';

/**
 * QwenToolCallRecoveryMiddleware
 *
 * 在 model 调用出口观察并修复 Qwen/DashScope 返回的 AIMessage：
 *  1. 当 `tool_calls` 为空但 `additional_kwargs.tool_calls` 有内容时，
 *     解析 raw payload 并回填到规范化字段。
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

interface NormalizedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  type: 'tool_call';
}

/**
 * 把"连续多个 JSON 对象拼接的字符串"切分为各自的 JSON 文本。
 *
 * 输入示例: `{"a":1}{"b":"}"}{"c":3}` → `['{"a":1}', '{"b":"}"}', '{"c":3}']`
 * 若没有有效切分（仍是单个对象或彻底无法解析），返回 `[]`，由调用方决定 fallback。
 */
function splitConcatenatedJsonObjects(raw: string): string[] {
  const out: string[] = [];
  const s = raw;
  const n = s.length;

  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < n; i++) {
    const ch = s[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (inString) {
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        out.push(s.slice(start, i + 1));
        start = -1;
      } else if (depth < 0) {
        // 异常：右括号过多，重置
        depth = 0;
        start = -1;
      }
    }
  }

  return out;
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/**
 * 把单个 raw tool_call 展开为一个或多个 NormalizedToolCall。
 * - arguments 是合法 object → 1 个
 * - arguments 是合法 JSON 字符串 → 1 个
 * - arguments 是被错误拼接的多对象字符串 → 拆成 N 个（共享 name，id 加 -i 后缀）
 * - 其他场景 → 1 个 args 为 `{}` 的兜底（保持原有语义，避免吞掉调用）
 */
function expandRawToolCall(r: RawToolCall): NormalizedToolCall[] {
  const name = r.function?.name ?? 'unknown';
  const baseId = r.id ?? '';
  const raw = r.function?.arguments;

  // 已经是 object
  if (raw && typeof raw === 'object') {
    return [
      {
        id: baseId,
        name,
        args: raw as Record<string, unknown>,
        type: 'tool_call',
      },
    ];
  }

  if (typeof raw !== 'string') {
    return [{ id: baseId, name, args: {}, type: 'tool_call' }];
  }

  const trimmed = raw.trim();

  // 单个 JSON 对象：常规路径
  const single = tryParseObject(trimmed);
  if (single) {
    return [{ id: baseId, name, args: single, type: 'tool_call' }];
  }

  // 多对象拼接：尝试切分
  const chunks = splitConcatenatedJsonObjects(trimmed);
  const parsed: Record<string, unknown>[] = [];
  for (const c of chunks) {
    const obj = tryParseObject(c);
    if (obj) parsed.push(obj);
  }

  if (parsed.length === 0) {
    console.warn('[QwenRecovery] failed to parse arguments; falling back to empty args', {
      name,
      preview: trimmed.slice(0, 200),
      length: trimmed.length,
    });
    return [{ id: baseId, name, args: {}, type: 'tool_call' }];
  }

  // 仅一个有效对象 —— 即使原文有多 chunk（如尾部噪声），也按单调用处理
  if (parsed.length === 1) {
    return [{ id: baseId, name, args: parsed[0], type: 'tool_call' }];
  }

  // 多个有效对象：去重后展开为多调用
  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];
  for (const p of parsed) {
    const key = JSON.stringify(p);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
  }

  console.warn('[QwenRecovery] split concatenated tool_call arguments', {
    name,
    rawCount: parsed.length,
    uniqueCount: unique.length,
  });

  return unique.map((args, i) => ({
    id: baseId ? `${baseId}-${i}` : '',
    name,
    args,
    type: 'tool_call' as const,
  }));
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
        const recovered: NormalizedToolCall[] = rawList
          .filter((r) => r && typeof r === 'object')
          .flatMap((r) => expandRawToolCall(r));

        if (recovered.length > 0) {
          msg.tool_calls = recovered;
        }
      } else if (structured.length > 0) {
        const allEmpty = structured.every(
          (tc: any) => !tc.args || Object.keys(tc.args).length === 0,
        );
        if (allEmpty && Array.isArray(rawList) && rawList.length > 0) {
          const recovered: NormalizedToolCall[] = rawList
            .filter((r) => r && typeof r === 'object')
            .flatMap((r) => expandRawToolCall(r));
          const anyNonEmpty = recovered.some((tc) => Object.keys(tc.args).length > 0);
          if (anyNonEmpty) {
            console.warn(
              '[QwenRecovery] structured tool_calls had empty args; rebuilt from raw payload',
              { structuredCount: structured.length, recoveredCount: recovered.length },
            );
            msg.tool_calls = recovered;
          }
        }
      }
    }

    return result;
  },
});
