/**
 * Sandbox 子系统统一出口。
 *
 * 对外暴露：抽象基类与类型、Provider 单例工厂、虚拟路径常量与工具集。
 * 虚拟路径映射/校验/脱敏等内部 helper 不在此导出，仅供 sandbox/tools.ts 使用。
 */

export {
  Sandbox,
  type GrepMatch,
  type GlobOptions,
  type GrepOptions,
  type GlobResult,
  type GrepResult,
} from './sandbox';
export { SandboxProvider } from './sandbox-provider';
export {
  getSandboxProvider,
  resetSandboxProvider,
  setSandboxProvider,
} from './provider-factory';
export { LocalSandboxProvider } from './local/local-sandbox-provider';
export { LocalSandbox } from './local/local-sandbox';
export { DockerSandboxProvider } from './docker/docker-sandbox-provider';
export { DockerSandbox } from './docker/docker-sandbox';
export { isDockerAvailable } from './docker/docker-cli';
export { getDockerSandboxConfig, type DockerSandboxConfig } from './docker/docker-config';
export {
  SandboxError,
  SandboxNotFoundError,
  SandboxRuntimeError,
  SandboxPermissionError,
  SandboxFileNotFoundError,
} from './exceptions';
export { isHostBashAllowed, LOCAL_HOST_BASH_DISABLED_MESSAGE } from './security';
export { getSandboxBaseDir, getThreadDirectories, type ThreadDirectories } from './paths';
export {
  getSandboxSnapshot,
  type SandboxSnapshot,
  type SandboxContainerSnapshot,
} from './sandbox-monitor';
export { VIRTUAL_PATH_PREFIX } from './path-utils';
export {
  SANDBOX_TOOLS,
  bashTool,
  lsTool,
  globTool,
  grepTool,
  readFileTool,
  writeFileTool,
  strReplaceTool,
} from './tools';
