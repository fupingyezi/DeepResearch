/**
 * Sandbox Provider 工厂：进程级单例，按环境变量选择后端。
 *
 * DEERFLOW_SANDBOX_BACKEND：
 *   - "local"（默认）：宿主文件系统沙箱，bash 直接在宿主执行（受 host-bash 门控）。
 *   - "docker"：每 thread 一个加固容器，bash 在容器内执行，具内核级隔离。
 *
 * 依赖方向：factory → local / docker，docker → local（DockerSandbox 继承 LocalSandbox），
 * 均为单向，无循环。setSandboxProvider 供测试注入。
 */

import { SandboxProvider } from './sandbox-provider';
import { LocalSandboxProvider } from './local/local-sandbox-provider';
import { DockerSandboxProvider } from './docker/docker-sandbox-provider';

let providerSingleton: SandboxProvider | null = null;

function createProviderFromEnv(): SandboxProvider {
  const backend = (process.env.DEERFLOW_SANDBOX_BACKEND || 'local').trim().toLowerCase();
  if (backend === 'docker') {
    return new DockerSandboxProvider();
  }
  return new LocalSandboxProvider();
}

export function getSandboxProvider(): SandboxProvider {
  if (providerSingleton === null) {
    providerSingleton = createProviderFromEnv();
  }
  return providerSingleton;
}

export function resetSandboxProvider(): void {
  providerSingleton = null;
}

export function setSandboxProvider(provider: SandboxProvider): void {
  providerSingleton = provider;
}
