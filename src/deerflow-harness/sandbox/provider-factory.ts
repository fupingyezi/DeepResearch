/**
 * Sandbox Provider 工厂：进程级单例，按环境变量选择后端。
 *
 * DEERFLOW_SANDBOX_BACKEND：
 *   - "local"（默认）：宿主文件系统沙箱，bash 直接在宿主执行（受 host-bash 门控）。
 *   - "docker"：每 thread 一个加固容器，bash 在容器内执行，具内核级隔离。
 *   - "remote"：每 thread 一条 SSH 长连接，命令与文件 IO 都在远程主机执行，远程即隔离边界。
 *
 * 依赖方向：factory → local / docker / remote，docker → local（DockerSandbox 继承
 * LocalSandbox），均为单向，无循环。setSandboxProvider 供测试注入。
 *
 * 注：remote 后端需要 DEERFLOW_REMOTE_HOST 与私钥配置，缺失时构造即抛错
 * （见 getRemoteSandboxConfig），避免静默降级到宿主直连。
 */

import { SandboxProvider } from './sandbox-provider';
import { LocalSandboxProvider } from './local/local-sandbox-provider';
import { DockerSandboxProvider } from './docker/docker-sandbox-provider';
import { RemoteSandboxProvider } from './remote/remote-sandbox-provider';

let providerSingleton: SandboxProvider | null = null;

function createProviderFromEnv(): SandboxProvider {
  const backend = (process.env.DEERFLOW_SANDBOX_BACKEND || 'local').trim().toLowerCase();
  if (backend === 'docker') {
    return new DockerSandboxProvider();
  }
  if (backend === 'remote') {
    return new RemoteSandboxProvider();
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
