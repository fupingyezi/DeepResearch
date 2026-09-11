/**
 * RemoteSandboxProvider：远程主机（SSH）沙箱 Provider。
 *
 * 生命周期：每 thread 一条长连接（SshConnectionManager 管理），acquire 幂等复用；
 * refCount 由 sandbox-middleware 的 retain/markIdle 驱动，归零且空闲超时后由
 * 连接管理器回收。线程目录布局与本地同构（`{baseDir}/threads/{threadId}/user-data/...`），
 * 使工具层的虚拟路径映射 / 校验 / 脱敏无需区分后端。
 */

import { Sandbox } from '../sandbox';
import { SandboxProvider } from '../sandbox-provider';
import type { ThreadDirectories } from '../paths';
import {
  getRemoteSandboxConfig,
  getRemoteThreadDirectories,
  type RemoteSandboxConfig,
} from './remote-config';
import { SshConnectionManager, type SshConnection } from './ssh-connection-manager';
import { RemoteSandbox } from './remote-sandbox';

export class RemoteSandboxProvider extends SandboxProvider {
  private readonly manager: SshConnectionManager;
  private readonly config: RemoteSandboxConfig;
  /** threadId → 该 thread 的沙箱实例（连接句柄的就绪 Promise 在内部 await）。 */
  private readonly sandboxes = new Map<string, RemoteSandbox>();
  /** 建立中的连接（防并发重复建连，也让 acquire 保持同步签名）。 */
  private readonly connecting = new Map<string, Promise<SshConnection>>();

  /**
   * @param manager 连接管理器；缺省新建（读 env 配置）。测试可注入假实现。
   * @param config  运行配置；缺省从 env 读取（缺 host / 私钥时抛错）
   */
  constructor(manager?: SshConnectionManager, config?: RemoteSandboxConfig) {
    super();
    this.config = config ?? getRemoteSandboxConfig();
    this.manager = manager ?? new SshConnectionManager(this.config);
  }

  /** 远程路径与本地路径同构（都是 posix），故直接复用 ThreadDirectories 形状。 */
  private toThreadDirectories(threadId: string): ThreadDirectories {
    return getRemoteThreadDirectories(threadId, this.config.baseDir);
  }

  /**
   * 获取（或复用）thread 的沙箱。
   *
   * 基类契约为同步返回 id（工具层紧接着 get(id)），但建连是异步的：这里同步返回 id，
   * 连接在后台建立；RemoteSandbox 的每个方法在真正 IO 前 await 该就绪 Promise。
   */
  acquire(threadId?: string): string {
    const id = sandboxId(threadId);
    if (this.sandboxes.has(id)) {
      // 幂等复用：仅刷新活跃时间；引用计数由 retain/markIdle 成对驱动，
      // 不随每次 acquire（含 subagent 惰性 acquire）累加，避免 refCount 泄漏。
      this.manager.heartbeat(id);
      return id;
    }

    const effectiveThreadId = id;
    const dirs = this.toThreadDirectories(effectiveThreadId);
    const connectionPromise = this.manager.acquire(effectiveThreadId);
    this.connecting.set(effectiveThreadId, connectionPromise);
    connectionPromise.catch((e) => {
      // 建连失败：清理占位，后续调用可重试
      this.sandboxes.delete(id);
      this.connecting.delete(effectiveThreadId);
      console.error(`[remote-sandbox] failed to connect thread=${effectiveThreadId}:`, e?.message);
    });

    const sandbox = new RemoteSandbox(
      id,
      makeDeferredConnection(connectionPromise),
      dirs,
      this.config,
    );
    this.sandboxes.set(id, sandbox);
    return id;
  }

  get(sandboxId: string): Sandbox | null {
    return this.sandboxes.get(sandboxId) ?? null;
  }

  release(sandboxId: string): void {
    this.releaseByThreadId(sandboxId);
  }

  override releaseByThreadId(threadId: string): void {
    const id = sandboxId(threadId);
    this.sandboxes.delete(id);
    this.connecting.delete(id);
    this.manager.releaseByThreadId(id);
  }

  override retain(sandboxId: string): void {
    this.manager.retain(sandboxId);
  }

  override markIdle(sandboxId: string): void {
    this.manager.markIdle(sandboxId);
  }

  override heartbeat(sandboxId: string): void {
    this.manager.heartbeat(sandboxId);
  }

  /** 远程主机即隔离边界：bash 不受 host-bash 门控（与 docker 同语义）。 */
  override isSecureIsolation(): boolean {
    return true;
  }

  /** 该后端 thread 工作目录的解析（远程路径，替代宿主 `.sandbox` 布局）。 */
  override threadDirectories(threadId: string): ThreadDirectories {
    return this.toThreadDirectories(threadId);
  }

  /**
   * 远程目录由连接管理器在建立连接时 `mkdir -p`（见 SshConnectionManager.createEntry），
   * 此处无需重复操作。
   */
  override async ensureThreadDirectories(_dirs: ThreadDirectories): Promise<void> {
    // no-op：建连时已创建
  }

  /** 监控快照：活跃连接与引用计数。 */
  connectionSnapshot(): Array<{ threadId: string; refCount: number; idleMs: number }> {
    return this.manager.snapshot();
  }
}

function sandboxId(threadId?: string): string {
  return threadId && threadId.length > 0 ? threadId : 'remote-default';
}

/**
 * 把「尚未就绪的连接 Promise」包装成 SshConnection：每个方法先 await 就绪，
 * 使 RemoteSandbox 无需感知建连时序。
 */
function makeDeferredConnection(promise: Promise<SshConnection>): SshConnection {
  return {
    threadId: 'pending',
    exec: async (command, options) => (await promise).exec(command, options),
    writeFile: async (remotePath, content, append) =>
      (await promise).writeFile(remotePath, content, append),
  };
}
