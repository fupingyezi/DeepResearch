/**
 * 提示词增强服务（输入框星星按钮）。
 *
 * 模型入口复用标题生成的副链路（setTitleModelFactory 注册的工厂 + TITLE_MODEL
 * hint，即默认 deepseek-v4-flash 这类小快模型），仅以更大 maxTokens 构建实例。
 *
 * 错误语义：
 * - 模型工厂未注册 / 无模型 → MODEL_UNAVAILABLE(503)
 * - 模型返回空（清洗后）→ EMPTY_RESULT(502)
 * - 调用异常 → 抛原错误（route 层统一 500）
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages';

import { getPromptEnhanceModel } from '@/deerflow-harness';
import { AppError } from '@/server/http';
import { ensureTitleModelFactory } from '@/server/wiring';

const ENHANCE_SYSTEM_PROMPT =
  "You are a prompt engineering assistant. Rewrite the user's draft into a clearer, " +
  'more specific, well-structured prompt for an AI assistant.\n' +
  'Rules:\n' +
  '- Preserve the original intent, language (reply in the SAME language as the draft), ' +
  'and every concrete detail, name, or constraint the user mentioned.\n' +
  '- Make implicit requirements explicit: goal, necessary context, expected output format, constraints.\n' +
  '- Keep it concise: expand only where clarity improves; no filler, no extra politeness.\n' +
  '- Output the enhanced prompt text ONLY — no explanations, no quotes, no markdown code fences.';

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: string; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
  }
  return parts.join('');
}

/**
 * 清洗：去 <think> 推理段 → 剥离整段 markdown 代码围栏 → 去首尾空白与包裹引号。
 */
export function sanitizeEnhanced(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/^```[\w-]*\s*\n?/, '').replace(/\n?```\s*$/, '');
  s = s.trim();
  s = s.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '');
  return s.trim();
}

export interface PromptEnhanceServiceDeps {
  ensureModelFactory: typeof ensureTitleModelFactory;
  getModel: typeof getPromptEnhanceModel;
}

export class PromptEnhanceService {
  constructor(private readonly deps: PromptEnhanceServiceDeps) {}

  /** 改写提示词，返回清洗后的文本（单值，无 envelope）。 */
  async enhance(input: string): Promise<string> {
    // threadService 可能尚未初始化（如新会话首条消息前就点增强），先确保工厂已注册
    this.deps.ensureModelFactory();
    const model = this.deps.getModel();
    if (!model) {
      throw new AppError(
        '模型不可用：副链路模型工厂未注册或 API Key 缺失',
        'MODEL_UNAVAILABLE',
        503,
      );
    }

    let resp;
    try {
      // callbacks: [] 显式切断外层回调链（本路由无 SSE，但保持项目约定防复用）
      resp = await model.invoke(
        [new SystemMessage(ENHANCE_SYSTEM_PROMPT), new HumanMessage(input)],
        { callbacks: [] },
      );
    } catch (e) {
      console.error('[prompt/enhance] invoke error:', e);
      throw e;
    }

    const enhanced = sanitizeEnhanced(extractText(resp.content));
    if (!enhanced) {
      console.error('[prompt/enhance] LLM returned empty, raw=', resp.content);
      throw new AppError('增强失败：模型返回为空', 'EMPTY_RESULT', 502);
    }
    return enhanced;
  }
}

const defaultDeps: PromptEnhanceServiceDeps = {
  ensureModelFactory: ensureTitleModelFactory,
  getModel: getPromptEnhanceModel,
};

/**
 * 工厂 + 模块级懒单例。无跨请求可变状态（模型实例来自 harness 副链路工厂
 * 注册表），模块级单例即可，无需 globalThis。
 */
export function createPromptEnhanceService(
  deps: PromptEnhanceServiceDeps = defaultDeps,
): PromptEnhanceService {
  return new PromptEnhanceService(deps);
}

let _promptEnhanceService: PromptEnhanceService | null = null;
export function getPromptEnhanceService(): PromptEnhanceService {
  if (!_promptEnhanceService) _promptEnhanceService = createPromptEnhanceService();
  return _promptEnhanceService;
}
