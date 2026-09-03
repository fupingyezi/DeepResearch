/**
 * LocalSandboxProvider：宿主文件系统沙箱 Provider。
 *
 * LocalSandbox 以单例形式复用（id 固定为 "local"）：跨线程共享同一实例，线程隔离
 * 由各工具按虚拟路径映射到不同 thread 目录实现，无需为每线程新建沙箱。
 *
 * 进程级单例工厂 getSandboxProvider() 迁移至 provider-factory.ts，以支持按 env
 * 选择 local / docker 后端且避免与 docker 实现形成循环依赖。
 */

import { Sandbox } from '../sandbox';
import { SandboxProvider } from '../sandbox-provider';
import { LocalSandbox } from './local-sandbox';

const LOCAL_SANDBOX_ID = 'local';

let localSingleton: LocalSandbox | null = null;

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
