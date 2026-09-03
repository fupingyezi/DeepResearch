/**
 * docker CLI 薄封装：所有调用用 execFile + 参数数组，绝不拼接 shell 字符串
 * （project.md 安全基线：避免 RCE / 命令注入）。
 *
 * runDocker 返回结构化结果；容器内命令执行走 `docker exec`，command 作为
 * 单个参数交给容器内 shell（sh -c），JS 侧不参与拼接。
 */

import { execFile } from 'node:child_process';

import { getDockerSandboxConfig } from './docker-config';

export interface DockerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/** 执行一次 docker 子命令（如 run/exec/rm）。timeoutMs<=0 表示不设超时。 */
export function runDocker(
  args: string[],
  opts: { timeoutMs?: number; input?: string } = {},
): Promise<DockerExecResult> {
  const { dockerBin } = getDockerSandboxConfig();
  const timeout = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 0;

  return new Promise<DockerExecResult>((resolve, reject) => {
    const child = execFile(
      dockerBin,
      args,
      { timeout, maxBuffer: DEFAULT_MAX_BUFFER, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`docker CLI not found ("${dockerBin}"): ${error.message}`));
          return;
        }
        const timedOut = Boolean(error && (error as { killed?: boolean }).killed);
        const exitCode =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code as number)
            : 0;
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode,
          timedOut,
        });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}

/** docker daemon 是否可用（`docker info` 成功）。 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const result = await runDocker(['info', '--format', '{{.ServerVersion}}'], {
      timeoutMs: 15_000,
    });
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
