/**
 * DockerSandbox 运行时配置：全部来自环境变量（project.md secrets=env-only），
 * 缺省值面向「本地研究场景」——够用且默认加固。
 *
 * 隔离边界说明：与 LocalSandbox 不同，DockerSandbox 的 bash 在独立容器内执行，
 * 具备内核级隔离，因此不受 DEERFLOW_ALLOW_HOST_BASH 门控（那是 host bash 专属）。
 *
 * 并行编排相关配置（多对话并行）：容器级并发上限、空闲回收间隔、命令重试、
 * 分布式锁 TTL；纵深防御相关：只读根文件系统 + tmpfs + swap 限制。
 */

/** 容器内规范挂载点：宿主 thread 的 user-data 目录挂到此路径，消除宿主真实路径泄露。 */
export const CONTAINER_USER_DATA_ROOT = '/mnt/user-data';

export interface DockerSandboxConfig {
  /** 容器镜像；需自带 bash + python + 常用检索工具。 */
  image: string;
  /** 容器名前缀；实际容器名为 `{prefix}-{sanitizedThreadId}`。 */
  containerNamePrefix: string;
  /** 内存上限（docker --memory 语法，如 "2g"）。 */
  memoryLimit: string;
  /**
   * swap 上限（docker --memory-swap 语法）。设为与 memoryLimit 相同即禁用 swap，
   * 防内存超限时靠 swap 绕过限额拖垮宿主。空串表示不设置（用 docker 默认）。
   */
  memorySwapLimit: string;
  /** CPU 配额（docker --cpus 语法，如 "1.5"）。 */
  cpuLimit: string;
  /** 进程数上限，防 fork 炸弹。 */
  pidsLimit: number;
  /** 网络模式："bridge"（默认，研究需联网）或 "none"（完全断网）。 */
  networkMode: string;
  /** 单条命令执行超时（毫秒）。 */
  commandTimeoutMs: number;
  /** 容器空闲多久后可被回收（毫秒）；由空闲回收器据此清理 refCount=0 的容器。 */
  idleTimeoutMs: number;
  /** 容器内运行用户（docker --user 语法，如 "1000:1000"）；降权，避免容器内 root。 */
  runAsUser: string;
  /** docker CLI 可执行路径。 */
  dockerBin: string;

  /** 活跃容器数上限（容器级并发闸门）；达上限时触发 LRU 淘汰或拒绝。 */
  maxLiveContainers: number;
  /** 空闲回收器扫描周期（毫秒）；驱动 idleTimeoutMs 到期回收。 */
  idleReapIntervalMs: number;
  /** acquire 分布式锁 TTL（毫秒）；防多进程并发重复建同名容器。 */
  acquireLockTtlMs: number;
  /** 回收器互斥锁 TTL（毫秒）；防多进程重复回收。 */
  reapLockTtlMs: number;
  /** 命令因容器消失等瞬时故障的最大重试次数（含首次外的重试）。 */
  commandMaxRetries: number;

  /** 是否只读根文件系统（--read-only）；写入仅允许挂载卷与 tmpfs。 */
  readOnlyRootfs: boolean;
  /** 只读根下提供的可写 tmpfs 大小（如 "64m"）；空串表示不挂 tmpfs。 */
  tmpfsSize: string;
}

function envStr(key: string, fallback: string): string {
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

function envInt(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value || value.trim().length === 0) return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (!value || value.trim().length === 0) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export function getDockerSandboxConfig(): DockerSandboxConfig {
  const memoryLimit = envStr('DEERFLOW_DOCKER_MEMORY', '2g');
  return {
    image: envStr('DEERFLOW_DOCKER_IMAGE', 'python:3.12-slim-bookworm'),
    containerNamePrefix: envStr('DEERFLOW_DOCKER_NAME_PREFIX', 'deerflow-sandbox'),
    memoryLimit,
    // 默认令 swap == memory，等效禁用 swap（防绕过内存限额）。
    memorySwapLimit: envStr('DEERFLOW_DOCKER_MEMORY_SWAP', memoryLimit),
    cpuLimit: envStr('DEERFLOW_DOCKER_CPUS', '1.5'),
    pidsLimit: envInt('DEERFLOW_DOCKER_PIDS_LIMIT', 256),
    networkMode: envStr('DEERFLOW_DOCKER_NETWORK', 'bridge'),
    commandTimeoutMs: envInt('DEERFLOW_DOCKER_COMMAND_TIMEOUT_MS', 600_000),
    idleTimeoutMs: envInt('DEERFLOW_DOCKER_IDLE_TIMEOUT_MS', 1_800_000),
    runAsUser: envStr('DEERFLOW_DOCKER_USER', '1000:1000'),
    dockerBin: envStr('DEERFLOW_DOCKER_BIN', 'docker'),

    maxLiveContainers: envInt('DEERFLOW_DOCKER_MAX_LIVE_CONTAINERS', 32),
    idleReapIntervalMs: envInt('DEERFLOW_DOCKER_IDLE_REAP_INTERVAL_MS', 60_000),
    acquireLockTtlMs: envInt('DEERFLOW_DOCKER_ACQUIRE_LOCK_TTL_MS', 30_000),
    reapLockTtlMs: envInt('DEERFLOW_DOCKER_REAP_LOCK_TTL_MS', 30_000),
    commandMaxRetries: envInt('DEERFLOW_DOCKER_COMMAND_MAX_RETRIES', 1),

    readOnlyRootfs: envBool('DEERFLOW_DOCKER_READONLY_ROOTFS', false),
    tmpfsSize: envStr('DEERFLOW_DOCKER_TMPFS_SIZE', '64m'),
  };
}
