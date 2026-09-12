import { afterEach, describe, expect, it } from 'vitest';

import { getRemoteSandboxConfig, getRemoteThreadDirectories } from './remote-config';

const MANAGED_KEYS = [
  'DEERFLOW_REMOTE_HOST',
  'DEERFLOW_REMOTE_PORT',
  'DEERFLOW_REMOTE_USER',
  'DEERFLOW_REMOTE_PRIVATE_KEY',
  'DEERFLOW_REMOTE_PRIVATE_KEY_PATH',
  'DEERFLOW_REMOTE_PASSPHRASE',
  'DEERFLOW_REMOTE_BASE_DIR',
  'DEERFLOW_REMOTE_MAX_CONCURRENT',
  'DEERFLOW_REMOTE_IDLE_TIMEOUT_MS',
  'DEERFLOW_REMOTE_COMMAND_TIMEOUT_MS',
  'DEERFLOW_REMOTE_KEEPALIVE_MS',
  'DEERFLOW_REMOTE_MAX_WRITE_BYTES',
];

const original: Record<string, string | undefined> = {};
for (const key of MANAGED_KEYS) original[key] = process.env[key];

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

function setBaseEnv(): void {
  for (const key of MANAGED_KEYS) delete process.env[key];
  process.env.DEERFLOW_REMOTE_HOST = 'sandbox.example.com';
  process.env.DEERFLOW_REMOTE_PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake';
}

describe('getRemoteSandboxConfig', () => {
  it('缺 host 时抛错（避免静默降级到宿主直连）', () => {
    setBaseEnv();
    delete process.env.DEERFLOW_REMOTE_HOST;
    expect(() => getRemoteSandboxConfig()).toThrow(/DEERFLOW_REMOTE_HOST/);
  });

  it('缺私钥时抛错', () => {
    setBaseEnv();
    delete process.env.DEERFLOW_REMOTE_PRIVATE_KEY;
    expect(() => getRemoteSandboxConfig()).toThrow(/private key/i);
  });

  it('缺省值：端口 22 / baseDir /tmp/deerflow-sandbox / 并发 8 / 写上限 2MB', () => {
    setBaseEnv();
    const config = getRemoteSandboxConfig();
    expect(config.port).toBe(22);
    expect(config.username).toBe('root');
    expect(config.baseDir).toBe('/tmp/deerflow-sandbox');
    expect(config.maxConcurrent).toBe(8);
    expect(config.idleTimeoutMs).toBe(30 * 60 * 1000);
    expect(config.commandTimeoutMs).toBe(600_000);
    expect(config.maxWriteBytes).toBe(2 * 1024 * 1024);
  });

  it('env 覆盖生效', () => {
    setBaseEnv();
    process.env.DEERFLOW_REMOTE_PORT = '2222';
    process.env.DEERFLOW_REMOTE_USER = 'sandbox';
    process.env.DEERFLOW_REMOTE_BASE_DIR = '/srv/deerflow';
    process.env.DEERFLOW_REMOTE_MAX_CONCURRENT = '3';
    const config = getRemoteSandboxConfig();
    expect(config.port).toBe(2222);
    expect(config.username).toBe('sandbox');
    expect(config.baseDir).toBe('/srv/deerflow');
    expect(config.maxConcurrent).toBe(3);
  });

  it('非法数值回落默认值', () => {
    setBaseEnv();
    process.env.DEERFLOW_REMOTE_PORT = 'not-a-number';
    process.env.DEERFLOW_REMOTE_MAX_CONCURRENT = '-4';
    const config = getRemoteSandboxConfig();
    expect(config.port).toBe(22);
    expect(config.maxConcurrent).toBe(8);
  });
});

describe('getRemoteThreadDirectories', () => {
  it('与本地布局同构（threads/{tid}/user-data/{workspace,uploads,outputs}）', () => {
    const dirs = getRemoteThreadDirectories('thread-1', '/tmp/deerflow-sandbox');
    expect(dirs.userData).toBe('/tmp/deerflow-sandbox/threads/thread-1/user-data');
    expect(dirs.workspace).toBe('/tmp/deerflow-sandbox/threads/thread-1/user-data/workspace');
    expect(dirs.uploads).toBe('/tmp/deerflow-sandbox/threads/thread-1/user-data/uploads');
    expect(dirs.outputs).toBe('/tmp/deerflow-sandbox/threads/thread-1/user-data/outputs');
  });

  it('不同 thread 目录互不重叠', () => {
    const a = getRemoteThreadDirectories('thread-a', '/srv/base');
    const b = getRemoteThreadDirectories('thread-b', '/srv/base');
    expect(a.workspace).not.toBe(b.workspace);
    expect(a.workspace.startsWith(b.userData)).toBe(false);
  });
});
