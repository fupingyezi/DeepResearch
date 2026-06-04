/**
 * extensions 子系统公共 API barrel。
 */

export {
  type McpTransport,
  type McpServerConfig,
  type SkillState,
  type ExtensionsConfig,
  mcpServerConfigSchema,
  skillStateSchema,
  extensionsConfigSchema,
  createEmptyExtensionsConfig,
  resolveEnvPlaceholders,
} from './types';

export {
  getExtensionsConfigPath,
  getSkillsRootDir,
  getPublicSkillsDir,
  getCustomSkillsDir,
} from './paths';

export {
  type ExtensionsConfigStore,
  FileExtensionsConfigStore,
  getExtensionsConfigStore,
  resetExtensionsConfigStore,
} from './config-store';
