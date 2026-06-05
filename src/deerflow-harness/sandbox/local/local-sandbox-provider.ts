/**
 * LocalSandboxProvider：宿主文件系统沙箱 Provider。
 *
 * LocalSandbox 以单例形式复用（id 固定为 "local"）：跨线程共享同一实例，线程隔离
 * 由各工具按虚拟路径映射到不同 thread 目录实现，无需为每线程新建沙箱。
 *
 * 本文件同时承载进程级单例工厂 getSandboxProvider()，保持「基类 → 实现」单向依赖。
 */

import { Sandbox } from '../sandbox';
import { SandboxProvider } from '../sandbox-provider';
import { LocalSandbox } from './local-sandbox';

const LOCAL_SANDBOX_ID = 'local';

let localSingleton: LocalSandbox | null = null;
let providerSingleton: SandboxProvider | null = null;

export class LocalSandboxProvider extends SandboxProvider {
  acquire(): string {
    if (localSingleton === null) {
      localSingleton = new LocalSandbox(LOCAL_SANDBOX_ID);
    }
    return localSingleton.id;
  }

  get(sandboxId: string): Sandbox | null {
    if (sandboxId !== LOCAL_SANDBOX_ID) return null;
    if (localSingleton === null) this.acquire();
    return localSingleton;
  }

  release(): void {
    // LocalSandbox 单例复用，无需逐次清理（保留多轮会话工作区）。
  }
}

export function getSandboxProvider(): SandboxProvider {
  if (providerSingleton === null) {
    providerSingleton = new LocalSandboxProvider();
  }
  return providerSingleton;
}

export function resetSandboxProvider(): void {
  providerSingleton = null;
  localSingleton = null;
}

export function setSandboxProvider(provider: SandboxProvider): void {
  providerSingleton = provider;
}
