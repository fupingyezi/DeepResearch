/**
 * 中间件装配配置的宿主侧读取（对齐 deer-flow 2.0 的 config.yaml 约定）。
 *
 * 边界：文件读取 / 路径解析 / 模块 require 归宿主（src/backend/config/）；
 * schema / parse / $VAR 替换在 harness（config/middleware-config.ts 纯函数收字符串）。
 *
 * 失败语义（与 extensions_config.json 的「损坏回退空配置」刻意不同）：
 * - 文件缺失 → SDK 默认（启动一次性 info；首次部署的常态，不是错误）；
 * - 文件存在但非法（语法错 / 未知键 / 版本不符）→ 大声抛错——装配配置
 *   静默降级等于「关护栏」「关循环检测」这类安全配置失效而不自知。
 * - 部分块缺失 → 逐块回落 SDK 默认（block 级合并，不是整文件回退）。
 *
 * 热生效：loadWithSignature 的签名 = mtime + 原文哈希，折入 agent 缓存键
 * （client.ts buildConfigKey 末位）——改 YAML 下轮 agent 构建自动重建。
 * env 替换后的值不进签名：签名只反映文件内容变化，$VAR 的解析值随进程
 * 启动定格（与 deer-flow 一致，env 变更需重启进程）。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  createDefaultMiddlewareConfigYaml,
  parseMiddlewareConfigYaml,
  type ClientOptions,
  type GuardrailBlockMode,
  type MiddlewareConfigSnapshot,
  type MiddlewareConfigYaml,
  type MiddlewareOptions,
} from '@deerflow-harness';

/** config.yaml 路径：DEERFLOW_CONFIG_PATH 显式指定，否则 {cwd}/config.yaml。 */
export function getDeerflowConfigPath(): string {
  return process.env.DEERFLOW_CONFIG_PATH || path.join(process.cwd(), 'config.yaml');
}

/**
 * 逐块合并 SDK 默认后的全量配置（每个块恒存在，消费方不用判空）。
 * 默认配置逐键全量（createDefaultMiddlewareConfigYaml）+ parsed 覆盖 → 键必齐，
 * 一次性断言在本文件内完成，不把「可能缺块」的负担摊给每个消费点。
 */
export interface ResolvedMiddlewareConfig {
  summarization: { enabled: boolean; trigger_tokens: number; keep_messages: number };
  loop_detection: {
    enabled: boolean;
    warn_threshold: number;
    hard_limit: number;
    window_size: number;
    tool_freq_warn: number;
    tool_freq_hard_limit: number;
  };
  guardrails: { enabled: boolean; block_mode: GuardrailBlockMode };
  title: { enabled: boolean };
  memory: {
    enabled: boolean;
    mode: 'inject' | 'retrieve';
    model_name: string | null;
    debounce_seconds: number;
    max_facts: number;
    fact_confidence_threshold: number;
    injection_enabled: boolean;
    max_injection_tokens: number;
    retrieve_top_k: number;
    retrieve_max_tokens: number;
    semantic_match_threshold: number;
    update_timeout_ms: number;
  };
  sandbox: { enabled: boolean };
  todo: { enabled: boolean };
  thread_data: { enabled: boolean };
  uploads: { enabled: boolean };
  subagent_limit: {
    enabled: boolean;
    max_concurrent: number;
    max_total: number;
    max_tracked_threads: number;
  };
  extensions: { middlewares: string[] };
}

export function resolveMiddlewareConfig(parsed: MiddlewareConfigYaml): ResolvedMiddlewareConfig {
  const d = createDefaultMiddlewareConfigYaml();
  return {
    summarization: { ...d.summarization, ...parsed.summarization },
    loop_detection: { ...d.loop_detection, ...parsed.loop_detection },
    guardrails: { ...d.guardrails, ...parsed.guardrails },
    title: { ...d.title, ...parsed.title },
    memory: { ...d.memory, ...parsed.memory },
    sandbox: { ...d.sandbox, ...parsed.sandbox },
    todo: { ...d.todo, ...parsed.todo },
    thread_data: { ...d.thread_data, ...parsed.thread_data },
    uploads: { ...d.uploads, ...parsed.uploads },
    subagent_limit: { ...d.subagent_limit, ...parsed.subagent_limit },
    // 列表是装配注入面的唯一真源，不做与默认的拼接（默认恒为空）
    extensions: { middlewares: [...(parsed.extensions?.middlewares ?? [])] },
  } as ResolvedMiddlewareConfig;
}

/** YAML 四个中间件选项块 → MiddlewareOptions（buildClientOptionsFromYaml / snapshot 共用）。 */
export function buildMiddlewareOptionsFromYaml(
  config: ResolvedMiddlewareConfig,
): MiddlewareOptions {
  return {
    guardrail: {
      // enabled 同时覆盖「链上挂载」（snapshot.enabled.guardrail）与「扫描开关」
      // （本字段）：键恒存在，故 DEERFLOW_GUARDRAIL_ENABLED/BLOCK 降为纯 fallback
      enabled: config.guardrails.enabled,
      blockMode: config.guardrails.block_mode,
    },
    subagentLimit: {
      enabled: config.subagent_limit.enabled,
      maxConcurrent: config.subagent_limit.max_concurrent,
      maxTotal: config.subagent_limit.max_total,
      maxTrackedThreads: config.subagent_limit.max_tracked_threads,
    },
    loopDetection: {
      enabled: config.loop_detection.enabled,
      warnThreshold: config.loop_detection.warn_threshold,
      hardLimit: config.loop_detection.hard_limit,
      windowSize: config.loop_detection.window_size,
      toolFreqWarn: config.loop_detection.tool_freq_warn,
      toolFreqHardLimit: config.loop_detection.tool_freq_hard_limit,
    },
    summarization: {
      triggerTokens: config.summarization.trigger_tokens,
      keepMessages: config.summarization.keep_messages,
    },
  };
}

/**
 * YAML → ClientOptions（服务级装配基线，wiring 用它构造 DeerFlowClient）。
 * mcp/subagents 不进 YAML：mcp 有 extensions_config.json 专属域，subagents 恒开。
 */
export function buildClientOptionsFromYaml(config: ResolvedMiddlewareConfig): ClientOptions {
  return {
    agentName: 'lead',
    memoryEnabled: config.memory.enabled,
    memoryMode: config.memory.mode,
    autoTitleEnabled: config.title.enabled,
    threadDataEnabled: config.thread_data.enabled,
    uploadsEnabled: config.uploads.enabled,
    sandboxEnabled: config.sandbox.enabled,
    summarizationEnabled: config.summarization.enabled,
    guardrailEnabled: config.guardrails.enabled,
    todoEnabled: config.todo.enabled,
    ...buildMiddlewareOptionsFromYaml(config),
  };
}

/** YAML → 装配快照（client 每轮 agent 构建前经 provider 取）。 */
export function buildMiddlewareConfigSnapshot(
  config: ResolvedMiddlewareConfig,
  signature: string,
): MiddlewareConfigSnapshot {
  return {
    enabled: {
      summarization: config.summarization.enabled,
      guardrail: config.guardrails.enabled,
      autoTitle: config.title.enabled,
      memory: config.memory.enabled,
      sandbox: config.sandbox.enabled,
      todo: config.todo.enabled,
      threadData: config.thread_data.enabled,
      uploads: config.uploads.enabled,
    },
    memoryMode: config.memory.mode,
    options: buildMiddlewareOptionsFromYaml(config),
    signature,
  };
}

export interface DeerflowConfigLoad {
  config: ResolvedMiddlewareConfig;
  signature: string;
  /** 配置文件是否存在（false = SDK 默认；调用方据此跳过 MemoryConfig 载入等）。 */
  fromFile: boolean;
}

interface CacheEntry {
  raw: string;
  mtimeMs: number;
  config: ResolvedMiddlewareConfig;
  signature: string;
}

export class DeerflowConfigStore {
  private cache: CacheEntry | null = null;
  private warnedMissing = false;

  private async readRaw(): Promise<{ raw: string | null; mtimeMs: number | null }> {
    const filePath = getDeerflowConfigPath();
    let mtimeMs: number | null;
    try {
      mtimeMs = (await fs.stat(filePath)).mtimeMs;
    } catch {
      mtimeMs = null;
    }
    if (mtimeMs === null) {
      if (!this.warnedMissing) {
        this.warnedMissing = true;
        console.info(`[deerflow-config] ${filePath} not found, using SDK defaults`);
      }
      return { raw: null, mtimeMs: null };
    }
    return { raw: await fs.readFile(filePath, 'utf-8'), mtimeMs };
  }

  /**
   * 读取 + 校验 + 逐块合并默认。mtime 缓存：文件未变更直接返回内存副本
   * （provider 每轮 agent 构建都会调，必须廉价）。非法内容抛错，错误信息
   * 带完整路径与 zod issues，便于在部署日志里定位。
   */
  async loadWithSignature(): Promise<DeerflowConfigLoad> {
    const filePath = getDeerflowConfigPath();
    const { raw, mtimeMs } = await this.readRaw();
    if (raw === null || mtimeMs === null) {
      return { config: resolveMiddlewareConfig({}), signature: '', fromFile: false };
    }
    if (this.cache && this.cache.mtimeMs === mtimeMs) {
      return {
        config: this.cache.config,
        signature: this.cache.signature,
        fromFile: true,
      };
    }
    let parsed: MiddlewareConfigYaml;
    try {
      parsed = parseMiddlewareConfigYaml(raw);
    } catch (e) {
      throw new Error(
        `[deerflow-config] invalid config file: ${filePath}\n` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const config = resolveMiddlewareConfig(parsed);
    // mtime + 原文哈希：任何编辑（含注释）都会使签名变化 → agent 缓存失效重建
    const signature = `${mtimeMs}:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
    this.cache = { raw, mtimeMs, config, signature };
    return { config, signature, fromFile: true };
  }
}

let _store: DeerflowConfigStore | null = null;

export function getDeerflowConfigStore(): DeerflowConfigStore {
  if (_store) return _store;
  _store = new DeerflowConfigStore();
  return _store;
}

export function resetDeerflowConfigStore(): void {
  _store = null;
}
