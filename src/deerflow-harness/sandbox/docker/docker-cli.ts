/**
 * docker CLI 薄封装：所有调用用 execFile + 参数数组，绝不拼接 shell 字符串
 * （project.md 安全基线：避免 RCE / 命令注入）。
 *
 * runDocker 返回结构化结果；容器内命令执行走 `docker exec`，command 作为
 * 单个参数交给容器内 shell（sh -c），JS 侧不参与拼接。
 *
 * 辅助能力（多对话并行编排用）：
 * - dockerPsByPrefix：按 name 前缀列出容器，供启动对账（reconcile）以 daemon 为真相源。
 * - dockerStats：单次采样容器资源占用，供只读监控 API。
 * - runDockerWithRetry：对瞬时故障做有限次退避重试。
 */

import { execFile } from 'node:child_process';

import { getDockerSandboxConfig } from './docker-config';

export interface DockerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface DockerContainerStats {
  containerName: string;
  cpuPerc: string;
  memUsage: string;
  memPerc: string;
  pids: string;
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

/**
 * 带有限次退避重试的 docker 调用：仅对「非超时且 exitCode!=0」的瞬时故障重试，
 * 超时不重试（避免叠加长耗时）。retries 为首次之外的额外尝试次数。
 */
export async function runDockerWithRetry(
  args: string[],
  opts: { timeoutMs?: number; input?: string; retries: number },
): Promise<DockerExecResult> {
  const { retries, ...runOpts } = opts;
  let last = await runDocker(args, runOpts);
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (last.exitCode === 0 || last.timedOut) return last;
    await delay(200 * (attempt + 1));
    last = await runDocker(args, runOpts);
  }
  return last;
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

/** 按容器名前缀列出容器名（含已停止），供启动对账以 daemon 为真相源。 */
export async function dockerPsByPrefix(prefix: string): Promise<string[]> {
  const result = await runDocker(
    ['ps', '-a', '--filter', `name=${prefix}-`, '--format', '{{.Names}}'],
    { timeoutMs: 15_000 },
  );
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name.length > 0 && name.startsWith(`${prefix}-`));
}

/** 单次采样指定容器的资源占用（--no-stream）；容器不存在返回 null。 */
export async function dockerStats(containerName: string): Promise<DockerContainerStats | null> {
  const result = await runDocker(
    [
      'stats',
      '--no-stream',
      '--format',
      '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.PIDs}}',
      containerName,
    ],
    { timeoutMs: 15_000 },
  );
  if (result.exitCode !== 0) return null;
  const line = result.stdout.trim().split('\n')[0] ?? '';
  const [cpuPerc, memUsage, memPerc, pids] = line.split('|');
  if (cpuPerc === undefined) return null;
  return {
    containerName,
    cpuPerc: cpuPerc ?? '',
    memUsage: memUsage ?? '',
    memPerc: memPerc ?? '',
    pids: pids ?? '',
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
