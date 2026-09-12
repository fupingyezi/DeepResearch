/**
 * RemoteSandbox 运行时配置：全部来自环境变量（project.md secrets=env-only）。
 *
 * 隔离边界说明：bash 在远程主机上执行，远程主机即隔离边界，因此不受
 * DEERFLOW_ALLOW_HOST_BASH 门控（那是「宿主直连」专属）。
 *
 * 与 docker 后端的差异：远程后端不做跨进程协调（Redis 计数/分布式锁）—— 每个
 * 进程维护自己的 SSH 连接池与并发闸门，多进程部署时上限按进程独立计。理由：
 * 远程连接无法像容器那样被其他进程回收，跨进程协调收益低而复杂度高。
 */

import * as fs from 'node:fs';

export interface RemoteSandboxConfig {
  /** 远程主机地址（缺省时后端不可用）。 */
  host: string;
  /** SSH 端口。 */
  port: number;
  /** 登录用户名。 */
  username: string;
  /** 私钥内容（PEM）。与 privateKeyPath 二选一，前者优先。 */
  privateKey: string;
  /** 私钥文件路径；privateKey 为空时读取。 */
  privateKeyPath: string;
  /** 私钥口令（可选）。 */
  passphrase: string;
  /**
   * 远程工作根目录。thread 目录布局与本地一致：
   *   {baseDir}/threads/{threadId}/user-data/{workspace,uploads,outputs}
   */
  baseDir: string;
  /** 进程内并发上限（活跃 SSH 连接数）。 */
  maxConcurrent: number;
  /** 连接空闲多久后可被回收（毫秒）。 */
  idleTimeoutMs: number;
  /** 单条命令执行超时（毫秒）。 */
  commandTimeoutMs: number;
  /** SSH keepalive 间隔（毫秒），防中间设备断开长连接。 */
  keepaliveIntervalMs: number;
  /** 单文件写入上限（字节），防 base64 往返造成内存峰值。 */
  maxWriteBytes: number;
}

const DEFAULT_BASE_DIR = '/tmp/deerflow-sandbox';
const DEFAULT_MAX_WRITE_BYTES = 2 * 1024 * 1024;

function envStr(key: string, fallback: string): string {
  const value = process.env[key];
  return value !== undefined && value.trim().length > 0 ? value.trim() : fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 读取私钥：优先 env 内联内容，其次 DEERFLOW_REMOTE_PRIVATE_KEY_PATH 指向的文件。 */
function readPrivateKey(config: { privateKey: string; privateKeyPath: string }): string {
  if (config.privateKey) return config.privateKey;
  if (!config.privateKeyPath) return '';
  try {
    return fs.readFileSync(config.privateKeyPath, 'utf-8');
  } catch (e) {
    console.warn(
      `[remote-sandbox] failed to read private key at ${config.privateKeyPath}:`,
      (e as Error)?.message,
    );
    return '';
  }
}

export function getRemoteSandboxConfig(): RemoteSandboxConfig {
  const config: RemoteSandboxConfig = {
    host: envStr('DEERFLOW_REMOTE_HOST', ''),
    port: envInt('DEERFLOW_REMOTE_PORT', 22),
    username: envStr('DEERFLOW_REMOTE_USER', 'root'),
    privateKey: process.env.DEERFLOW_REMOTE_PRIVATE_KEY ?? '',
    privateKeyPath: envStr('DEERFLOW_REMOTE_PRIVATE_KEY_PATH', ''),
    passphrase: process.env.DEERFLOW_REMOTE_PASSPHRASE ?? '',
    baseDir: envStr('DEERFLOW_REMOTE_BASE_DIR', DEFAULT_BASE_DIR),
    maxConcurrent: envInt('DEERFLOW_REMOTE_MAX_CONCURRENT', 8),
    idleTimeoutMs: envInt('DEERFLOW_REMOTE_IDLE_TIMEOUT_MS', 30 * 60 * 1000),
    commandTimeoutMs: envInt('DEERFLOW_REMOTE_COMMAND_TIMEOUT_MS', 600_000),
    keepaliveIntervalMs: envInt('DEERFLOW_REMOTE_KEEPALIVE_MS', 15_000),
    maxWriteBytes: envInt('DEERFLOW_REMOTE_MAX_WRITE_BYTES', DEFAULT_MAX_WRITE_BYTES),
  };

  if (!config.host) {
    throw new Error(
      'Remote sandbox backend requires DEERFLOW_REMOTE_HOST ' +
        '(set DEERFLOW_SANDBOX_BACKEND=remote only when a remote host is configured)',
    );
  }
  if (!readPrivateKey(config)) {
    throw new Error(
      'Remote sandbox backend requires an SSH private key: set DEERFLOW_REMOTE_PRIVATE_KEY ' +
        'or DEERFLOW_REMOTE_PRIVATE_KEY_PATH',
    );
  }
  return config;
}

/** 取出可用的私钥内容（供连接管理器调用，避免重复读文件）。 */
export function resolveRemotePrivateKey(config: RemoteSandboxConfig): string {
  return readPrivateKey(config);
}

/**
 * 远程 thread 目录布局（posix 路径）。
 *
 * 与本地 `getThreadDirectories` 同构，使工具层的虚拟路径映射 / 命令路径校验 /
 * 输出脱敏无需区分后端。
 */
export interface RemoteThreadDirectories {
  userData: string;
  workspace: string;
  uploads: string;
  outputs: string;
}

export function getRemoteThreadDirectories(
  threadId: string,
  baseDir: string,
): RemoteThreadDirectories {
  const userData = `${baseDir}/threads/${threadId}/user-data`;
  return {
    userData,
    workspace: `${userData}/workspace`,
    uploads: `${userData}/uploads`,
    outputs: `${userData}/outputs`,
  };
}
