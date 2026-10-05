/**
 * Guardrail 规则集（零外部依赖，纯函数便于单测）
 *
 * 两类规则：
 * - `injection`：提示注入（prompt injection）——扫描**用户输入**，
 *   高置信度模式（宁缺毋滥，避免正常提问被误伤）；
 * - `sensitive`：敏感信息外泄——扫描**工具输出**，识别常见凭据/私钥/证件号。
 *
 * 设计取舍：规则抓的是「明显模式」，不追求召回率。命中后默认只告警
 * （见 guardrail-middleware 的 blockMode），误报不会打断主链路。
 */

export type GuardrailScope = 'injection' | 'sensitive';

export interface GuardrailRule {
  /** 规则标识（日志与拦截文案中可见）。 */
  id: string;
  scope: GuardrailScope;
  /** 命中即判定（整段正则，非全局匹配，避免 lastIndex 状态）。 */
  pattern: RegExp;
}

export interface GuardrailHit {
  id: string;
  scope: GuardrailScope;
  /** 命中的片段（已截断，仅用于日志；不回传给模型以免二次泄露）。 */
  excerpt: string;
}

/** 单次扫描的文本上限：避免超长输入造成正则回溯开销。 */
export const GUARDRAIL_SCAN_MAX_CHARS = 20_480;

/** 命中片段在日志中的最大长度。 */
const EXCERPT_MAX_CHARS = 80;

const INJECTION_RULES: GuardrailRule[] = [
  {
    id: 'ignore-previous-instructions',
    scope: 'injection',
    pattern:
      /(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instruction|instructions|prompt|prompts|rule|rules)/i,
  },
  {
    id: 'reveal-system-prompt',
    scope: 'injection',
    pattern:
      /(reveal|show|print|repeat|output|leak)\s+(me\s+)?(your\s+|the\s+)?(system\s+)?(prompt|instructions|rules)/i,
  },
  {
    id: 'role-override',
    scope: 'injection',
    pattern:
      /(you\s+are\s+now|from\s+now\s+on\s+you\s+are|act\s+as\s+if\s+you\s+(have\s+no|are\s+not))\s+/i,
  },
  {
    id: 'ignore-previous-instructions-zh',
    scope: 'injection',
    // 必须带限定词（以上/之前/所有/你的...，可连用如「以上所有」），
    // 避免「忽略指令」这类正常讨论被误判
    pattern:
      /(忽略|无视|忘记)(\s*(以上|之前|上面|前面|先前|所有|全部|你(的)?|系统)\s*(的)?)+\s*(指令|指示|提示词|要求|设定|规则)/,
  },
  {
    id: 'reveal-system-prompt-zh',
    scope: 'injection',
    pattern:
      /(输出|显示|打印|告诉我|复述|泄露)\s*(你的|系统)?\s*(系统)?\s*(提示词|prompt|设定|指令)/i,
  },
];

const SENSITIVE_RULES: GuardrailRule[] = [
  { id: 'openai-key', scope: 'sensitive', pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { id: 'anthropic-key', scope: 'sensitive', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'aws-access-key', scope: 'sensitive', pattern: /AKIA[0-9A-Z]{16}/ },
  { id: 'github-token', scope: 'sensitive', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { id: 'slack-token', scope: 'sensitive', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  {
    id: 'private-key-block',
    scope: 'sensitive',
    pattern: /-----BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+|PGP\s+|DSA\s+)?PRIVATE KEY-----/,
  },
  {
    id: 'cn-id-card',
    scope: 'sensitive',
    pattern: /\b[1-9]\d{5}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/,
  },
];

/** 按 scope 取规则集。 */
export function rulesForScope(scope: GuardrailScope): GuardrailRule[] {
  return scope === 'injection' ? INJECTION_RULES : SENSITIVE_RULES;
}

function toHit(rule: GuardrailRule, matched: string): GuardrailHit {
  return {
    id: rule.id,
    scope: rule.scope,
    excerpt: matched.slice(0, EXCERPT_MAX_CHARS),
  };
}

/** 扫描文本，返回首个命中规则；无命中返回 null。 */
export function scanForScope(text: string, scope: GuardrailScope): GuardrailHit | null {
  if (!text) return null;
  const sample =
    text.length > GUARDRAIL_SCAN_MAX_CHARS ? text.slice(0, GUARDRAIL_SCAN_MAX_CHARS) : text;
  for (const rule of rulesForScope(scope)) {
    const matched = sample.match(rule.pattern);
    if (matched) return toHit(rule, matched[0]);
  }
  return null;
}

/** 扫描用户输入中的提示注入模式。 */
export function scanPromptInjection(text: string): GuardrailHit | null {
  return scanForScope(text, 'injection');
}

/** 扫描工具输出中的敏感信息模式。 */
export function scanSensitiveOutput(text: string): GuardrailHit | null {
  return scanForScope(text, 'sensitive');
}
