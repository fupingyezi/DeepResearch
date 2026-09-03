/**
 * DockerSandbox 运行时配置：全部来自环境变量（project.md secrets=env-only），
 * 缺省值面向「本地研究场景」——够用且默认加固。
 *
 * 隔离边界说明：与 LocalSandbox 不同，DockerSandbox 的 bash 在独立容器内执行，
 * 具备内核级隔离，因此不受 DEERFLOW_ALLOW_HOST_BASH 门控（那是 host bash 专属）。
 */

export interface DockerSandboxConfig {
  /** 容器镜像；需自带 bash + python + 常用检索工具。 */
  image: string;
  /** 容器内工作/挂载根：宿主 {base}/threads/{tid} 挂到容器同名路径，保持路径契约一致。 */
  containerNamePrefix: string;
  /** 内存上限（docker --memory 语法，如 "2g"）。 */
  memoryLimit: string;
  /** CPU 配额（docker --cpus 语法，如 "1.5"）。 */
  cpuLimit: string;
  /** 进程数上限，防 fork 炸弹。 */
  pidsLimit: number;
  /** 网络模式："bridge"（默认，研究需联网）或 "none"（完全断网）。 */
  networkMode: string;
  /** 单条命令执行超时（毫秒）。 */
  commandTimeoutMs: number;
  /** 容器空闲多久后可被回收（毫秒）；provider 释放时据此清理。 */
  idleTimeoutMs: number;
  /** 容器内运行用户（docker --user 语法，如 "1000:1000"）；降权，避免容器内 root。 */
  runAsUser: string;
  /** docker CLI 可执行路径。 */
  dockerBin: string;
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

export function getDockerSandboxConfig(): DockerSandboxConfig {
  return {
    image: envStr('DEERFLOW_DOCKER_IMAGE', 'python:3.12-slim-bookworm'),
    containerNamePrefix: envStr('DEERFLOW_DOCKER_NAME_PREFIX', 'deerflow-sandbox'),
    memoryLimit: envStr('DEERFLOW_DOCKER_MEMORY', '2g'),
    cpuLimit: envStr('DEERFLOW_DOCKER_CPUS', '1.5'),
    pidsLimit: envInt('DEERFLOW_DOCKER_PIDS_LIMIT', 256),
    networkMode: envStr('DEERFLOW_DOCKER_NETWORK', 'bridge'),
    commandTimeoutMs: envInt('DEERFLOW_DOCKER_COMMAND_TIMEOUT_MS', 600_000),
    idleTimeoutMs: envInt('DEERFLOW_DOCKER_IDLE_TIMEOUT_MS', 1_800_000),
    runAsUser: envStr('DEERFLOW_DOCKER_USER', '1000:1000'),
    dockerBin: envStr('DEERFLOW_DOCKER_BIN', 'docker'),
  };
}
