import { createMiddleware } from 'langchain';
import { AIMessage, ToolMessage } from '@langchain/core/messages';

import { scanPromptInjection, scanSensitiveOutput, type GuardrailHit } from './guardrail/rules';

/**
 * GuardrailMiddleware（features.guardrail 启用，位序 4）
 *
 * 规则式轻量护栏，零外部依赖：
 * - `wrapModelCall`：扫描**最新一条用户消息**，命中提示注入模式（如
 *   "ignore all previous instructions"、"输出你的系统提示词"）时告警；
 * - `wrapToolCall`：扫描**工具输出**，命中凭据/私钥/证件号模式时告警。
 *
 * 处置策略由 `blockMode` 决定：默认 `none`（仅告警，不改变行为），
 * 可收紧为 `injection` / `output` / `all` 做硬拦截。
 *
 * 告警经 `console.warn`（`[guardrail]` 前缀）+ LangGraph custom writer
 * 推送 `guardrail_alert` payload。该 payload **不进** ClientAgentEvent 白名单
 * （避免污染前后端协议）；需要时可在 DeerFlowClient 侧再映射为客户端事件。
 */

export type GuardrailBlockMode = 'none' | 'injection' | 'output' | 'all';

export interface GuardrailOptions {
  /** 总开关（默认取 env DEERFLOW_GUARDRAIL_ENABLED，未设则开）。 */
  enabled?: boolean;
  /** 硬拦截范围（默认取 env DEERFLOW_GUARDRAIL_BLOCK，未设则 none 仅告警）。 */
  blockMode?: GuardrailBlockMode;
}

const BLOCK_MODES: GuardrailBlockMode[] = ['none', 'injection', 'output', 'all'];

/**
 * 占位常量：供 ORDERED_MIDDLEWARES 位序文档引用。
 * 真实装配请用 createGuardrailMiddleware()。
 */
export const guardrailMiddleware = createMiddleware({
  name: 'GuardrailMiddleware',
});

function readEnabledFromEnv(): boolean {
  const raw = process.env.DEERFLOW_GUARDRAIL_ENABLED;
  if (raw === undefined || raw.trim() === '') return true;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function readBlockModeFromEnv(): GuardrailBlockMode {
  const raw = (process.env.DEERFLOW_GUARDRAIL_BLOCK ?? '').trim().toLowerCase();
  return (BLOCK_MODES as string[]).includes(raw) ? (raw as GuardrailBlockMode) : 'none';
}

/** 从消息 content 中提取纯文本（兼容分块 content 数组形态）。 */
function toPlainText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (
        block &&
        typeof block === 'object' &&
        typeof (block as { text?: string }).text === 'string'
      ) {
        return (block as { text: string }).text;
      }
      return '';
    })
    .join('\n');
}

/** 告警：日志 + custom writer（writer 不可用或抛错都不影响主流程）。 */
function reportHit(hit: GuardrailHit, context: Record<string, unknown>): void {
  console.warn(
    `[guardrail] ${hit.scope} hit rule=${hit.id} ` +
      Object.entries(context)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ') +
      ` excerpt=${JSON.stringify(hit.excerpt)}`,
  );
}

export function createGuardrailMiddleware(
  options?: GuardrailOptions,
): ReturnType<typeof createMiddleware> {
  const enabled = options?.enabled ?? readEnabledFromEnv();
  const blockMode = options?.blockMode ?? readBlockModeFromEnv();
  const blockInjection = blockMode === 'injection' || blockMode === 'all';
  const blockOutput = blockMode === 'output' || blockMode === 'all';

  return createMiddleware({
    name: 'GuardrailMiddleware',

    wrapModelCall: async (request, handler) => {
      if (!enabled) return handler(request);

      // 只扫最新一条 human 消息：历史轮次已在当时判定过，避免重复告警开销
      const messages = request.messages ?? [];
      const latestHuman = [...messages].reverse().find((m) => m._getType() === 'human');
      const hit = latestHuman ? scanPromptInjection(toPlainText(latestHuman.content)) : null;

      if (hit) {
        const threadId = request.runtime?.configurable?.thread_id ?? '-';
        reportHit(hit, { scope: 'injection', thread: threadId, blocked: blockInjection });
        try {
          request.runtime?.writer?.({ type: 'guardrail_alert', ...hit, blocked: blockInjection });
        } catch (err) {
          console.warn('[guardrail] writer push failed:', err);
        }
        if (blockInjection) {
          return new AIMessage({
            content:
              '[guardrail] 该请求包含疑似提示注入内容，已被安全策略拦截。请调整你的提问后重试。',
          });
        }
      }

      return handler(request);
    },

    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      if (!enabled) return result;

      const text = toPlainText((result as ToolMessage | undefined)?.content);
      const hit = text ? scanSensitiveOutput(text) : null;

      if (hit) {
        const toolName = String(request.toolCall?.name ?? 'unknown_tool');
        reportHit(hit, { scope: 'sensitive', tool: toolName, blocked: blockOutput });
        try {
          request.runtime?.writer?.({ type: 'guardrail_alert', ...hit, blocked: blockOutput });
        } catch (err) {
          console.warn('[guardrail] writer push failed:', err);
        }
        if (blockOutput) {
          return new ToolMessage({
            content: `[guardrail] 工具输出命中敏感信息规则（${hit.id}），已被安全策略拦截。`,
            tool_call_id: String(request.toolCall?.id ?? 'missing_tool_call_id'),
            name: toolName,
            status: 'success',
          });
        }
      }

      return result;
    },
  });
}
