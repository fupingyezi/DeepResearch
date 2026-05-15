/**
 * Tools Module — deerflow-harness
 *
 * 统一工具注册与管理。
 *
 * - 静态工具：直接 export
 * - 动态装载：通过 getAvailableTools(opts) 按需聚合（用于 subagent 内部工具集）
 *
 * @module deerflow-harness/tools
 */

import type { StructuredToolInterface } from '@langchain/core/tools';

import { searchWebTool } from './search-web-tool';
import { taskTool } from './builtins';

export { searchWebTool } from './search-web-tool';
export { taskTool } from './builtins';

export interface GetAvailableToolsOptions {
  /** 工具名白名单（按工具的 `name` 属性匹配）；缺省返回所有非 task 工具。 */
  groups?: string[];
  /** 是否允许装载 task 工具（subagent 内部应强制 false）。 */
  subagentEnabled?: boolean;
  /** 预留：模型名称，部分工具可能根据模型决定是否启用。 */
  modelName?: string;
}

/**
 * 工具名 → 实例映射。新增工具在此处登记即可被 getAvailableTools 发现。
 */
function buildToolRegistry(): Map<string, StructuredToolInterface> {
  const registry = new Map<string, StructuredToolInterface>();
  for (const t of [searchWebTool, taskTool]) {
    const name = (t as { name?: string }).name;
    if (!name) continue;
    registry.set(name, t as StructuredToolInterface);
  }
  return registry;
}

/**
 * 按 opts 返回符合条件的工具列表。
 *
 * - subagentEnabled=false 时强制移除 `task` 工具，杜绝 subagent → subagent 套娃。
 * - groups 命中时按白名单过滤；缺省时返回除 `task` 外的全部工具。
 */
export async function getAvailableTools(
  opts: GetAvailableToolsOptions = {},
): Promise<StructuredToolInterface[]> {
  const { groups, subagentEnabled } = opts;
  const registry = buildToolRegistry();

  const wanted: StructuredToolInterface[] = [];
  if (groups && groups.length > 0) {
    for (const name of groups) {
      const t = registry.get(name);
      if (t) wanted.push(t);
    }
  } else {
    // 缺省：所有工具，但默认排除 task（仅 lead agent 显式启用 subagent 时才注入）
    for (const [name, t] of registry) {
      if (name === 'task') continue;
      wanted.push(t);
    }
  }

  if (subagentEnabled === false) {
    return wanted.filter((t) => (t as { name?: string }).name !== 'task');
  }
  return wanted;
}
