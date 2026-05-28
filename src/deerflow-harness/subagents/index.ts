/**
 * subagents barrel
 *
 * 导入此模块时通过 `./builtins` 副作用完成所有内置 subagent 注册。
 */
import './builtins';

export { SubagentExecutor } from './executor';
export type { SubagentExecutorOptions } from './executor';
export {
  registerSubagent,
  getSubagentConfig,
  getAvailableSubagentNames,
  clearRegistry,
} from './registry';
export type { SubagentConfig } from './config';
export { generalPurposeConfig } from './builtins/general-purpose';
