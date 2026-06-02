import { createMiddleware } from 'langchain';
import { randomUUID } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';

/**
 * QwenToolCallRecoveryMiddleware
 *
 * 在 model 调用出口观察并修复 Qwen/DashScope 返回的 AIMessage：
 * 当 `tool_calls` 为空但 `additional_kwargs.tool_calls` 有内容时，
 *     解析 raw payload 并回填到规范化字段。
 *
 * 关键：Qwen/DashScope 兼容 OpenAI 协议时常常给出空字符串的 `id`，
 * 这会导致 ToolNode 生成的 ToolMessage 也带空 tool_call_id，
 * 下一轮无法与产生它的 AIMessage 配对，形成"模型反复重发同一 tool_call"
 * 的死循环。这里若发现 id 缺失则合成一个稳定 id（`qwen-tc-<uuid>`），
 * 保证 LangGraph 内部可正确串联 tool_call ↔ tool_result。
 */

function synthesizeToolCallId(): string {
  return `qwen-tc-${randomUUID()}`;
}

interface RawToolCall {
  id?: string;
  type?: string;
  index?: number;
  function?: {
    name?: string;
    arguments?: any;
  };
}

interface NormalizedToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
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

function tryParseObject(text: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
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
 *
 */
function expandRawToolCall(r: RawToolCall): NormalizedToolCall[] {
  const rawName = typeof r.function?.name === 'string' ? r.function.name.trim() : '';
  if (!rawName) {
    console.warn('[QwenRecovery] dropping raw tool_call without name', {
      hasArgs: typeof r.function?.arguments !== 'undefined',
      idPreview: typeof r.id === 'string' ? r.id.slice(0, 24) : null,
    });
    return [];
  }
  const name = rawName;
  // Qwen/DashScope 偶发 id 为空字符串：必须合成一个稳定 id，
  // 否则后续 ToolNode 生成的 ToolMessage.tool_call_id 也会是空，
  // 与 AIMessage.tool_calls[].id 无法配对 → graph 死循环重发 tool_calls。
  const rawId = typeof r.id === 'string' ? r.id.trim() : '';
  const baseId = rawId || synthesizeToolCallId();
  const raw = r.function?.arguments;

  // 已经是 object
  if (raw && typeof raw === 'object') {
    return [
      {
        id: baseId,
        name,
        args: raw as Record<string, any>,
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
  const parsed: Record<string, any>[] = [];
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
  const unique: Record<string, any>[] = [];
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
    // baseId 已确保非空（缺失时已合成）；多调用展开时附加索引保证唯一。
    id: `${baseId}-${i}`,
    name,
    args,
    type: 'tool_call' as const,
  }));
}

export const qwenToolCallRecoveryMiddleware = createMiddleware({
  name: 'QwenToolCallRecoveryMiddleware',
  wrapModelCall: async (request, handler) => {
    const result = await handler(request);

    const msg = ((result as { message?: unknown })?.message ?? result) as AIMessage;

    if (msg && AIMessage.isInstance(msg)) {
      const structured = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const rawList = (msg.additional_kwargs?.tool_calls ?? []) as RawToolCall[];

      if (process.env.MW_TRACE === '1' || process.env.MW_TRACE === 'true') {
        console.log('[QwenRecovery] model out', {
          contentLen: typeof msg.content === 'string' ? msg.content.length : -1,
          structuredCount: structured.length,
          rawCount: Array.isArray(rawList) ? rawList.length : 0,
          rawSample: Array.isArray(rawList) ? rawList[0] : undefined,
          addKwKeys: msg.additional_kwargs ? Object.keys(msg.additional_kwargs) : [],
        });
      }

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

      // 最终一致性兜底（顺序很重要：先清洗坏掉的 tool_calls，再补 id）：
      //
      // 1) 丢弃 name 缺失/空字符串/'unknown' 的 tool_calls。
      // 2) 保证 tool_calls[].id 与 additional_kwargs.tool_calls[].id 都为非空稳定字符串。
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const before = msg.tool_calls.length;
        const cleaned = msg.tool_calls.filter((tc: any) => {
          if (!tc) return false;
          const n = typeof tc.name === 'string' ? tc.name.trim() : '';
          if (!n || n === 'unknown') return false;
          return true;
        });
        if (cleaned.length !== before) {
          console.warn('[QwenRecovery] dropped tool_calls without a valid name', {
            before,
            after: cleaned.length,
          });
        }
        msg.tool_calls = cleaned;

        const rawArr = msg.additional_kwargs?.tool_calls;
        if (Array.isArray(rawArr) && rawArr.length > 0) {
          msg.additional_kwargs.tool_calls = rawArr.filter((r: any) => {
            const fn = r?.function;
            const n = typeof fn?.name === 'string' ? fn.name.trim() : '';
            return n && n !== 'unknown';
          });
        }
      }

      const finalCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (finalCalls.length > 0) {
        let mutated = false;
        for (const tc of finalCalls) {
          if (!tc) continue;
          if (typeof tc.id !== 'string' || tc.id.trim() === '') {
            tc.id = synthesizeToolCallId();
            mutated = true;
          }
        }
        // 与 raw 侧对齐：按 index 把规范化 id 同步回 additional_kwargs.tool_calls[i].id，
        // 避免 DanglingToolCallMiddleware 走 fallback 路径时再次因空 id 跳过。
        const rawArr = msg.additional_kwargs?.tool_calls;
        if (Array.isArray(rawArr)) {
          for (let i = 0; i < rawArr.length && i < finalCalls.length; i++) {
            const raw = rawArr[i];
            const sid = finalCalls[i]?.id;
            if (raw && typeof raw === 'object' && sid && (!raw.id || raw.id === '')) {
              raw.id = sid;
              mutated = true;
            }
          }
        }
        if (mutated) {
          console.warn('[QwenRecovery] synthesized missing tool_call ids', {
            count: finalCalls.length,
          });
        }
      }
    }

    return result;
  },
});
