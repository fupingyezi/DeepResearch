/**
 * POST /api/prompt/enhance —— 提示词增强（输入框星星按钮）。
 *
 * 模型入口复用标题生成的副链路（setTitleModelFactory 注册的工厂 + TITLE_MODEL
 * hint，即默认 deepseek-v4-flash 这类小快模型），仅以更大 maxTokens 构建实例。
 * 需登录（会话 cookie）；输入非空且 ≤ 8000 字符；输出仅返回改写后的提示词。
 */

import { NextRequest, NextResponse } from 'next/server';

import { HumanMessage, SystemMessage } from '@langchain/core/messages';

import { getPromptEnhanceModel } from '@/deerflow-harness';
import { getCurrentUser } from '../../auth/_helpers';
import { ensureTitleModelFactory } from '../../threads/_service';

const MAX_INPUT_CHARS = 8000;

const ENHANCE_SYSTEM_PROMPT =
  "You are a prompt engineering assistant. Rewrite the user's draft into a clearer, " +
  'more specific, well-structured prompt for an AI assistant.\n' +
  'Rules:\n' +
  '- Preserve the original intent, language (reply in the SAME language as the draft), ' +
  'and every concrete detail, name, or constraint the user mentioned.\n' +
  '- Make implicit requirements explicit: goal, necessary context, expected output format, constraints.\n' +
  '- Keep it concise: expand only where clarity improves; no filler, no extra politeness.\n' +
  '- Output the enhanced prompt text ONLY — no explanations, no quotes, no markdown code fences.';

interface EnhanceBody {
  input?: unknown;
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as EnhanceBody | null;
  const input = typeof body?.input === 'string' ? body.input.trim() : '';
  if (!input) {
    return NextResponse.json({ message: 'input 不能为空' }, { status: 400 });
  }
  if (input.length > MAX_INPUT_CHARS) {
    return NextResponse.json(
      { message: `input 过长（≤ ${MAX_INPUT_CHARS} 字符）` },
      { status: 400 },
    );
  }

  // threadService 可能尚未初始化（如新会话首条消息前就点增强），先确保工厂已注册
  ensureTitleModelFactory();
  const model = getPromptEnhanceModel();
  if (!model) {
    return NextResponse.json(
      { message: '模型不可用：副链路模型工厂未注册或 API Key 缺失' },
      { status: 503 },
    );
  }

  try {
    // callbacks: [] 显式切断外层回调链（本路由无 SSE，但保持项目约定防复用）
    const resp = await model.invoke(
      [new SystemMessage(ENHANCE_SYSTEM_PROMPT), new HumanMessage(input)],
      {
        callbacks: [],
      },
    );
    const enhanced = sanitizeEnhanced(extractText(resp.content));
    if (!enhanced) {
      console.error('[prompt/enhance] LLM returned empty, raw=', resp.content);
      return NextResponse.json({ message: '增强失败：模型返回为空' }, { status: 502 });
    }
    return NextResponse.json({ enhanced });
  } catch (error) {
    console.error('[prompt/enhance] invoke error:', error);
    return NextResponse.json(
      {
        message: '增强失败',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

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
function sanitizeEnhanced(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/^```[\w-]*\s*\n?/, '').replace(/\n?```\s*$/, '');
  s = s.trim();
  s = s.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '');
  return s.trim();
}
