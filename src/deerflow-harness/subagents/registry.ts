import { SubagentConfig } from './config';

/**
 * Subagent 注册表（进程内 Map）
 *
 * - 通过 import 副作用在模块加载时注册，无需上层显式调用。
 * - 注册键为 `config.name`，重复注册会覆盖并打印 warn。
 */
const registry = new Map<string, SubagentConfig>();

export function registerSubagent(config: SubagentConfig): void {
  if (!config?.name) {
    throw new Error('[subagents] registerSubagent: config.name is required');
  }
  if (registry.has(config.name)) {
    console.warn(`[subagents] registerSubagent: overriding existing subagent "${config.name}"`);
  }
  registry.set(config.name, config);
}

export function getSubagentConfig(name: string): SubagentConfig | undefined {
  return registry.get(name);
}

export function getAvailableSubagentNames(): string[] {
  return Array.from(registry.keys()).sort();
}

/** 仅供测试使用：清空注册表。 */
export function clearRegistry(): void {
  registry.clear();
}
