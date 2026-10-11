/**
 * 中间件装配的 YAML 配置（对齐 deer-flow 2.0 的 config.yaml 约定）。
 *
 * 约定与 deer-flow 2.0 一致：**顺序不写在 YAML 里**——装配顺序仍是
 * factory.ts 的固定 append 列表；YAML 只承担三件事：
 * 1. 各中间件专属选项块的 `enabled` 开关与参数（summarization / loop_detection /
 *    guardrails / title / memory / sandbox / todo / thread_data / uploads / subagent_limit）；
 * 2. `extensions.middlewares` 自定义中间件模块路径列表（宿主解析，见 backend 侧 loader）；
 * 3. runtime 门控不进 YAML：vision 由 modelConfig.supportsVision 驱动、
 *    qwen recovery 由 provider='qwen' 自动；恒开安全件
 *    （tool_call_integrity / tool_error_handling）不给 enabled 键。
 *
 * 边界：本文件只做「字符串 → 校验后的对象」纯解析（js-yaml + zod strict，
 * 未知键大声失败）。文件读取 / 路径解析 / 模块 require 归宿主——extensions
 * 里的模块路径是宿主代码，harness 无法解析；且仓库约定「env 解析归宿主」
 * 只豁免了 MCP/skills 这类 harness 自消费配置域，本配置的消费方是宿主装配。
 */

import { load } from 'js-yaml';
import { z } from 'zod';

import type { GuardrailOptions } from '../agents/middlewares';
import type { LoopDetectionOptions } from '../agents/middlewares';
import type { SubagentLimitOptions } from '../agents/middlewares';
import type { SummarizationOptions } from '../agents/middlewares';
import { DEFAULT_MEMORY_CONFIG } from '../agents/memory/config';

// ── schema（zod v4：z.object 默认剥离未知键，必须用 z.strictObject 才能
//    让「YAML 拼错键」大声失败而不是被静默丢弃）──

const enabledBlock = z.strictObject({
  enabled: z.boolean(),
});

const summarizationBlockSchema = z.strictObject({
  enabled: z.boolean(),
  trigger_tokens: z.number().int().positive().optional(),
  keep_messages: z.number().int().positive().optional(),
});

const loopDetectionBlockSchema = z.strictObject({
  enabled: z.boolean(),
  warn_threshold: z.number().int().positive().optional(),
  hard_limit: z.number().int().positive().optional(),
  window_size: z.number().int().positive().optional(),
  tool_freq_warn: z.number().int().positive().optional(),
  tool_freq_hard_limit: z.number().int().positive().optional(),
});

const guardrailsBlockSchema = z.strictObject({
  enabled: z.boolean(),
  block_mode: z.enum(['none', 'injection', 'output', 'all']).optional(),
});

const memoryBlockSchema = z.strictObject({
  enabled: z.boolean(),
  mode: z.enum(['inject', 'retrieve']).optional(),
  model_name: z.string().nullable().optional(),
  debounce_seconds: z.number().optional(),
  max_facts: z.number().optional(),
  fact_confidence_threshold: z.number().optional(),
  injection_enabled: z.boolean().optional(),
  max_injection_tokens: z.number().optional(),
  retrieve_top_k: z.number().optional(),
  retrieve_max_tokens: z.number().optional(),
  semantic_match_threshold: z.number().optional(),
  update_timeout_ms: z.number().optional(),
});

const subagentLimitBlockSchema = z.strictObject({
  enabled: z.boolean(),
  max_concurrent: z.number().int().positive().optional(),
  max_total: z.number().int().positive().optional(),
  max_tracked_threads: z.number().int().positive().optional(),
});

const extensionsBlockSchema = z.strictObject({
  middlewares: z.array(z.string()).optional(),
});

export const middlewareConfigYamlSchema = z.strictObject({
  config_version: z.number().int().optional(),
  summarization: summarizationBlockSchema.optional(),
  loop_detection: loopDetectionBlockSchema.optional(),
  guardrails: guardrailsBlockSchema.optional(),
  title: enabledBlock.optional(),
  memory: memoryBlockSchema.optional(),
  sandbox: enabledBlock.optional(),
  todo: enabledBlock.optional(),
  thread_data: enabledBlock.optional(),
  uploads: enabledBlock.optional(),
  subagent_limit: subagentLimitBlockSchema.optional(),
  extensions: extensionsBlockSchema.optional(),
});

export type MiddlewareConfigYaml = z.infer<typeof middlewareConfigYamlSchema>;

/** 当前唯一支持的 config_version；给别的值抛错（schema 演进闸门）。 */
export const MIDDLEWARE_CONFIG_VERSION = 1;

/**
 * 递归替换字符串值里的 `$VAR` / `${VAR}` 占位符（对齐 deer-flow 的
 * resolve_env_variables）。只处理 string（数字/布尔原样透传）；未解析的
 * 占位符替换为空串——保留字面 `$VAR` 只会把无意义字面量传进装配。
 * 有界再解析 ≤3 轮：环境变量值本身可以再含占位符（如 `A="$B"`）。
 */
export function resolveConfigEnvPlaceholders(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (let i = 0; i < 3 && /\$\{?\w+\}?/.test(out); i++) {
      out = out.replace(/\$\{?(\w+)\}?/g, (_, name: string) => process.env[name] ?? '');
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveConfigEnvPlaceholders(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveConfigEnvPlaceholders(item, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * 解析中间件装配 YAML 文本：js-yaml → $VAR 替换 → zod strict 校验 →
 * config_version 闸门。语法错 / 未知键 / 类型错 / 版本不符一律抛错
 * （ZodError 带全量 issues；版本错误带明确 message）。
 */
export function parseMiddlewareConfigYaml(text: string): MiddlewareConfigYaml {
  // 空文件 / 纯注释文件 load 返回 undefined，归一为空对象走全默认
  const raw = load(text) ?? {};
  const resolved = resolveConfigEnvPlaceholders(raw);
  const parsed = middlewareConfigYamlSchema.parse(resolved);
  if (parsed.config_version !== undefined && parsed.config_version !== MIDDLEWARE_CONFIG_VERSION) {
    throw new Error(
      `unsupported config_version: ${parsed.config_version} (expected ${MIDDLEWARE_CONFIG_VERSION})`,
    );
  }
  return parsed;
}

/**
 * SDK 默认配置（config.yaml 缺失时的兜底）——值 = 服务级装配的基线
 * （8 开关全开 + 各中间件选项取构造器常量默认 + MemoryConfig 默认）。
 * 锁定测试逐键钉死，防与提交的 config.yaml 漂移。
 */
export function createDefaultMiddlewareConfigYaml(): MiddlewareConfigYaml {
  return {
    config_version: MIDDLEWARE_CONFIG_VERSION,
    summarization: { enabled: true, trigger_tokens: 12000, keep_messages: 8 },
    loop_detection: {
      enabled: true,
      warn_threshold: 3,
      hard_limit: 5,
      window_size: 20,
      tool_freq_warn: 30,
      tool_freq_hard_limit: 50,
    },
    guardrails: { enabled: true, block_mode: 'none' },
    title: { enabled: true },
    memory: {
      enabled: true,
      mode: 'inject',
      model_name: DEFAULT_MEMORY_CONFIG.modelName,
      debounce_seconds: DEFAULT_MEMORY_CONFIG.debounceSeconds,
      max_facts: DEFAULT_MEMORY_CONFIG.maxFacts,
      fact_confidence_threshold: DEFAULT_MEMORY_CONFIG.factConfidenceThreshold,
      injection_enabled: DEFAULT_MEMORY_CONFIG.injectionEnabled,
      max_injection_tokens: DEFAULT_MEMORY_CONFIG.maxInjectionTokens,
      retrieve_top_k: DEFAULT_MEMORY_CONFIG.retrieveTopK,
      retrieve_max_tokens: DEFAULT_MEMORY_CONFIG.retrieveMaxTokens,
      semantic_match_threshold: DEFAULT_MEMORY_CONFIG.semanticMatchThreshold,
      update_timeout_ms: DEFAULT_MEMORY_CONFIG.updateTimeoutMs,
    },
    sandbox: { enabled: true },
    todo: { enabled: true },
    thread_data: { enabled: true },
    uploads: { enabled: true },
    subagent_limit: { enabled: true, max_concurrent: 3, max_total: 8, max_tracked_threads: 100 },
    extensions: { middlewares: [] },
  };
}

// ── 装配快照：宿主把 YAML 映射为 client 消费的开关 + 选项 + 签名 ──

/** 服务级开关（metadata 严格 boolean 仍可单请求覆盖）。 */
export interface MiddlewareConfigSnapshot {
  enabled: {
    summarization: boolean;
    guardrail: boolean;
    autoTitle: boolean;
    memory: boolean;
    sandbox: boolean;
    todo: boolean;
    threadData: boolean;
    uploads: boolean;
  };
  /** 记忆注入模式服务级默认（metadata.memoryMode 仍可单请求覆盖）。 */
  memoryMode: 'inject' | 'retrieve';
  /** 中间件选项（factory 的 create* 消费；undefined = 构造器默认）。 */
  options: {
    guardrail?: GuardrailOptions;
    subagentLimit?: SubagentLimitOptions;
    loopDetection?: LoopDetectionOptions;
    summarization?: SummarizationOptions;
  };
  /** 折入 agent 缓存键的配置签名（宿主按原文哈希计算；变化 → 缓存失效重建）。 */
  signature: string;
}

/** 宿主注入的配置读取器（每次 agent 构建前调用，背后应有 mtime 缓存）。 */
export type MiddlewareConfigProvider = () => Promise<MiddlewareConfigSnapshot>;
