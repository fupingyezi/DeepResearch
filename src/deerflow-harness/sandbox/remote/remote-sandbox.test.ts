import { describe, expect, it } from 'vitest';

import { shellQuote, type ExecOutcome, type SshConnection } from './ssh-connection-manager';
import { RemoteSandbox } from './remote-sandbox';
import { getRemoteThreadDirectories, type RemoteSandboxConfig } from './remote-config';
import { maskLocalPathsInOutput, resolveAndValidateUserDataPath } from '../path-utils';

const DIRS = getRemoteThreadDirectories('thread-1', '/tmp/deerflow-sandbox');

/** 显式配置：避免测试依赖 env（getRemoteSandboxConfig 在缺 host 时会抛错）。 */
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

/** 构造带显式配置的 sandbox（所有用例共用）。 */
function makeSandbox(connection: SshConnection): RemoteSandbox {
  return new RemoteSandbox('id', connection, DIRS, CONFIG);
}

/** 记录命令并返回预设结果的假连接（不真正建连）。 */
function fakeConnection(
  responses: Array<Partial<ExecOutcome>> = [],
  writes: Array<{ path: string; content: string; append: boolean }> = [],
): SshConnection {
  let index = 0;
  return {
    threadId: 'thread-1',
    exec: async (): Promise<ExecOutcome> => {
      const preset = responses[index++] ?? {};
      return {
        stdout: preset.stdout ?? '',
        stderr: preset.stderr ?? '',
        exitCode: preset.exitCode ?? 0,
        timedOut: preset.timedOut ?? false,
        durationMs: 1,
      };
    },
    writeFile: async (path, content, append) => {
      writes.push({ path, content, append });
    },
  };
}

describe('shellQuote', () => {
  it('普通字符串加单引号', () => {
    expect(shellQuote('/tmp/a b')).toBe("'/tmp/a b'");
  });

  it('内部单引号被安全转义（防命令注入）', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
  });
});

describe('RemoteSandbox —— 输出格式与本地一致', () => {
  it('非零退出码追加 Exit Code 行', async () => {
    const sandbox = makeSandbox(
      fakeConnection([{ stdout: 'partial', exitCode: 1, stderr: 'boom' }]),
    );
    const output = await sandbox.executeCommand('false');
    expect(output).toContain('partial');
    expect(output).toContain('Std Error:\nboom');
    expect(output).toContain('Exit Code: 1');
  });

  it('无输出时返回 (no output)', async () => {
    const sandbox = makeSandbox(fakeConnection([{ stdout: '' }]));
    expect(await sandbox.executeCommand('true')).toBe('(no output)');
  });

  it('超时追加 Timed out 行', async () => {
    const sandbox = makeSandbox(fakeConnection([{ stdout: '', timedOut: true, exitCode: 124 }]));
    expect(await sandbox.executeCommand('sleep 999')).toContain('Timed out after');
  });
});

describe('RemoteSandbox —— 输出脱敏（远程路径 → 虚拟路径）', () => {
  it('grep 结果把远程真实路径替换回 /mnt/user-data', async () => {
    const sandbox = makeSandbox(
      fakeConnection([
        {
          stdout: [
            `${DIRS.workspace}/notes.md:12:量子计算进展`,
            `${DIRS.outputs}/report.md:3:结论`,
          ].join('\n'),
        },
      ]),
    );

    const result = await sandbox.grep('/mnt/user-data/workspace', '.*');
    expect(result.matches).toEqual([
      { path: '/mnt/user-data/workspace/notes.md', lineNumber: 12, line: '量子计算进展' },
      { path: '/mnt/user-data/outputs/report.md', lineNumber: 3, line: '结论' },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('grep 结果不含宿主/远程真实路径结构', async () => {
    const sandbox = makeSandbox(fakeConnection([{ stdout: `${DIRS.workspace}/a.txt:1:hit` }]));
    const result = await sandbox.grep('/mnt/user-data/workspace', 'hit');
    expect(JSON.stringify(result)).not.toContain('/tmp/deerflow-sandbox');
  });

  it('超过 maxResults 时标记 truncated 并截断', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `${DIRS.workspace}/f${i}.txt:1:hit`).join(
      '\n',
    );
    const sandbox = makeSandbox(fakeConnection([{ stdout: lines }]));
    const result = await sandbox.grep('/mnt/user-data/workspace', 'hit', { maxResults: 3 });
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('glob 结果同样返回虚拟路径', async () => {
    const sandbox = makeSandbox(
      fakeConnection([{ stdout: `${DIRS.workspace}/a.ts\n${DIRS.workspace}/b.ts` }]),
    );
    const result = await sandbox.glob('/mnt/user-data/workspace', '*.ts');
    expect(result.matches).toEqual([
      '/mnt/user-data/workspace/a.ts',
      '/mnt/user-data/workspace/b.ts',
    ]);
  });
});

describe('RemoteSandbox —— writeFile 限制与转发', () => {
  it('超限写入被拒绝（防 base64/内存峰值）', async () => {
    const sandbox = makeSandbox(fakeConnection());
    const huge = 'x'.repeat(3 * 1024 * 1024);
    await expect(sandbox.writeFile(`${DIRS.workspace}/big.txt`, huge)).rejects.toThrow(
      /exceeds DEERFLOW_REMOTE_MAX_WRITE_BYTES/,
    );
  });

  it('正常写入转发到连接层（含 append 语义）', async () => {
    const writes: Array<{ path: string; content: string; append: boolean }> = [];
    const sandbox = makeSandbox(fakeConnection([], writes));
    await sandbox.writeFile(`${DIRS.workspace}/a.txt`, 'hi', true);
    expect(writes).toEqual([{ path: `${DIRS.workspace}/a.txt`, content: 'hi', append: true }]);
  });
});

describe('RemoteSandbox —— 与 path-utils 协同（远程路径即为「真实路径」）', () => {
  const threadData = {
    workspacePath: DIRS.workspace,
    uploadsPath: DIRS.uploads,
    outputsPath: DIRS.outputs,
  };

  it('虚拟路径解析到远程目录', () => {
    expect(resolveAndValidateUserDataPath('/mnt/user-data/workspace/x.md', threadData)).toBe(
      `${DIRS.workspace}/x.md`,
    );
  });

  it('越界路径被拒绝（远程后端同样受路径校验保护）', () => {
    expect(() =>
      resolveAndValidateUserDataPath('/mnt/user-data/../../etc/passwd', threadData),
    ).toThrow(/traversal/i);
  });

  it('输出脱敏把远程前缀替换回虚拟前缀', () => {
    const text = `wrote ${DIRS.workspace}/a.md`;
    expect(maskLocalPathsInOutput(text, threadData)).toContain('/mnt/user-data/workspace/a.md');
    expect(maskLocalPathsInOutput(text, threadData)).not.toContain('/tmp/deerflow-sandbox');
  });
});
