import { describe, expect, it } from 'vitest';

import { RemoteSandboxProvider } from './remote-sandbox-provider';
import { SshConnectionManager, type SshConnection } from './ssh-connection-manager';
import type { RemoteSandboxConfig } from './remote-config';

const CONFIG: RemoteSandboxConfig = {
  host: 'sandbox.example.com',
  port: 22,
  username: 'sandbox',
  privateKey: 'fake',
  privateKeyPath: '',
  passphrase: '',
  baseDir: '/tmp/deerflow-sandbox',
  maxConcurrent: 8,
  idleTimeoutMs: 30 * 60 * 1000,
  commandTimeoutMs: 600_000,
  keepaliveIntervalMs: 15_000,
  maxWriteBytes: 2 * 1024 * 1024,
};

/** 记录调用序列的假连接管理器（不真正建连）。 */
function fakeManager() {
  const calls: string[] = [];
  const connection: SshConnection = {
    threadId: 't',
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, durationMs: 0 }),
    writeFile: async () => {},
  };
  const manager = {
    acquire: async (threadId: string) => {
      calls.push(`acquire:${threadId}`);
      return connection;
    },
    retain: (threadId: string) => calls.push(`retain:${threadId}`),
    markIdle: (threadId: string) => calls.push(`markIdle:${threadId}`),
    heartbeat: (threadId: string) => calls.push(`heartbeat:${threadId}`),
    releaseByThreadId: (threadId: string) => calls.push(`release:${threadId}`),
    snapshot: () => [],
  } as unknown as SshConnectionManager;
  return { manager, calls };
}

/** 构造注入配置的 provider（不读 env，用例间互不干扰）。 */
function makeProvider(manager: SshConnectionManager, baseDir = CONFIG.baseDir) {
  return new RemoteSandboxProvider(manager, { ...CONFIG, baseDir });
}

describe('RemoteSandboxProvider —— 引用计数语义（与 docker 后端一致）', () => {
  it('首次 acquire 建连，但不自行增计数', () => {
    const { manager, calls } = fakeManager();
    const provider = makeProvider(manager);

    provider.acquire('thread-1');
    expect(calls).toEqual(['acquire:thread-1']);
    expect(calls).not.toContain('retain:thread-1');
  });

  it('重复 acquire 只 touch（heartbeat），不增不减计数', () => {
    const { manager, calls } = fakeManager();
    const provider = makeProvider(manager);

    provider.acquire('thread-1');
    provider.acquire('thread-1');
    expect(calls).toEqual(['acquire:thread-1', 'heartbeat:thread-1']);
  });

  it('retain / markIdle 成对驱动计数（由 sandbox-middleware 调用）', () => {
    const { manager, calls } = fakeManager();
    const provider = makeProvider(manager);

    provider.acquire('thread-1');
    provider.retain('thread-1');
    provider.markIdle('thread-1');
    expect(calls).toEqual(['acquire:thread-1', 'retain:thread-1', 'markIdle:thread-1']);
  });

  it('releaseByThreadId 关闭连接并清理沙箱实例', () => {
    const { manager, calls } = fakeManager();
    const provider = makeProvider(manager);

    provider.acquire('thread-1');
    const sandboxId = provider.acquire('thread-1');
    expect(provider.get(sandboxId)).not.toBeNull();

    provider.releaseByThreadId('thread-1');
    expect(calls).toContain('release:thread-1');
    expect(provider.get(sandboxId)).toBeNull();
  });
});

describe('RemoteSandboxProvider —— 后端契约', () => {
  it('isSecureIsolation=true（远程即边界，bash 不受 host-bash 门控）', () => {
    const { manager } = fakeManager();
    expect(makeProvider(manager).isSecureIsolation()).toBe(true);
  });

  it('threadDirectories 返回远程布局（与本地同构）', () => {
    const { manager } = fakeManager();
    const dirs = makeProvider(manager, '/srv/deerflow').threadDirectories('thread-9');
    expect(dirs.workspace).toBe('/srv/deerflow/threads/thread-9/user-data/workspace');
    expect(dirs.outputs).toBe('/srv/deerflow/threads/thread-9/user-data/outputs');
  });

  it('ensureThreadDirectories 为 no-op（建连时已创建远程目录）', async () => {
    const { manager } = fakeManager();
    await expect(
      makeProvider(manager).ensureThreadDirectories({
        userData: '',
        workspace: '/nope',
        uploads: '',
        outputs: '',
      }),
    ).resolves.toBeUndefined();
  });
});
