import { createMiddleware } from 'langchain';
import { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { IntegrityRule, RuleContext } from './types';
import { DEFAULT_INTEGRITY_RULES } from './rules';

/**
 * ToolCallIntegrityMiddleware（位序 3 / 始终启用）
 *
 * 统一处理消息层面的工具调用完整性问题。具体规则以 IntegrityRule 形式注册：
 *
 *  - DanglingToolCallRule：补齐缺失 ToolMessage（中断/取消/断流场景）
 *  - UnknownToolCallRule：剔除引用未知工具的 tool_call 并补占位
 *
 * 新增异常类型 → 实现一个 IntegrityRule 加到 rules/index.ts，**不再加新中间件**。
 *
 * 为什么把这两件事合并在同一个中间件里？
 *   - 都作用于 wrapModelCall 的入/出口
 *   - 都修改 messages / AIMessage.tool_calls
 *   - 顺序敏感（见 rules/index.ts 注释）
 *   把它们放在不同中间件里会让"中间件之间的协作顺序"额外暴露在外，
 *   而其实它们是同一类问题的不同分支。集中后中间件链更稳定，外层装配
 *   层（factory.assembleFromFeatures）只需关心一个位序。
 *
 * 与 ToolErrorHandlingMiddleware 的边界：
 *   - 本中间件解决"消息进入 ToolNode 之前的格式/引用不一致"
 *   - ToolErrorHandlingMiddleware 解决"工具自身执行抛出的异常"
 *   两者位序相邻、职责互补，不可互替。
 */

export interface ToolCallIntegrityOptions {
  /** 自定义规则集合；默认使用 DEFAULT_INTEGRITY_RULES */
  rules?: readonly IntegrityRule[];
}

function buildKnownToolNames(tools: unknown): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(tools)) return set;
  for (const t of tools) {
    const name = (t as { name?: string })?.name;
    if (typeof name === 'string' && name.length > 0) set.add(name);
  }
  return set;
}

/**
 * 顺序应用所有规则的 sanitizeHistory，串行修补 messages。
 * 任一规则返回新数组，后续规则即基于新数组继续修补。
 */
function applyHistoryRules(
  messages: BaseMessage[],
  rules: readonly IntegrityRule[],
  ctx: RuleContext,
): BaseMessage[] | null {
  let current: BaseMessage[] = messages;
  let mutated = false;

  for (const rule of rules) {
    if (!rule.sanitizeHistory) continue;
    const next = rule.sanitizeHistory(current, ctx);
    if (next) {
      current = next;
      mutated = true;
    }
  }

  return mutated ? current : null;
}

/** 顺序应用所有规则的 sanitizeOutput，直接 mutate 模型刚返回的 AIMessage。 */
function applyOutputRules(
  result: any,
  rules: readonly IntegrityRule[],
  ctx: RuleContext,
): void {
  const msg: any = result?.message ?? result;
  if (!msg || !AIMessage.isInstance(msg)) return;
  for (const rule of rules) {
    if (rule.sanitizeOutput) rule.sanitizeOutput(msg, ctx);
  }
}

export function createToolCallIntegrityMiddleware(
  options: ToolCallIntegrityOptions = {},
) {
  const rules = options.rules ?? DEFAULT_INTEGRITY_RULES;

  return createMiddleware({
    name: 'ToolCallIntegrityMiddleware',
    wrapModelCall: async (request, handler) => {
      const ctx: RuleContext = {
        knownToolNames: buildKnownToolNames((request as any).tools),
      };

      let effectiveRequest = request;
      try {
        const patched = applyHistoryRules(request.messages, rules, ctx);
        if (patched) {
          effectiveRequest = { ...request, messages: patched };
        }
      } catch (err) {
        console.error(
          '[ToolCallIntegrityMiddleware] sanitizeHistory threw, fallback to original messages:',
          (err as Error)?.message ?? err,
        );
      }

      const result = await handler(effectiveRequest);

      try {
        applyOutputRules(result, rules, ctx);
      } catch (err) {
        console.error(
          '[ToolCallIntegrityMiddleware] sanitizeOutput threw, ignored:',
          (err as Error)?.message ?? err,
        );
      }

      return result;
    },
  });
}

/** 默认实例：装配链直接使用即可。 */
export const toolCallIntegrityMiddleware = createToolCallIntegrityMiddleware();

export type { IntegrityRule, RuleContext } from './types';
export { DEFAULT_INTEGRITY_RULES } from './rules';
