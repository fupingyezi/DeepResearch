/**
 * DockerSandbox：在独立容器内执行 bash，实现内核级隔离。
 *
 * 设计要点（最小改动 + 契约一致）：
 * - 文件读写/检索（read/write/list/glob/grep）直接复用 LocalSandbox：宿主的 thread
 *   user-data 目录被 bind mount 进容器 /mnt/user-data，宿主侧文件操作 == 容器内可见，
 *   因此无需重复实现，也天然与容器内 bash 看到同一份文件。
 * - 仅重写 executeCommand：命令通过 `docker exec` 投递到本 thread 的长驻容器内执行，
 *   享有资源限额 / 能力裁剪 / 网络隔离（由 provider 创建容器时设定）。
 *
 * 路径映射（卷挂载到容器内规范路径的必然要求）：
 * - 工具层（bashTool）已把命令里的 /mnt/user-data 替换为宿主真实路径，并 cd 到宿主
 *   workspace。但容器内不存在宿主真实路径（挂载点是 /mnt/user-data），故本类在投递前
 *   把命令与工作目录里的「宿主 user-data 根」反向映射回容器内 /mnt/user-data。
 *
 * 容错：命令因容器消失（如被回收/崩溃）失败时，触发 reprovision 重建并有限次重试。
 */

import { LocalSandbox } from '../local/local-sandbox';
import { runDocker, type DockerExecResult } from './docker-cli';
import { CONTAINER_USER_DATA_ROOT, getDockerSandboxConfig } from './docker-config';

/** docker exec 目标容器不存在时的典型 stderr 片段（触发重建重试）。 */
const CONTAINER_MISSING_HINTS = ['No such container', 'is not running', 'not found'];

const LOG = '[docker-sandbox]';
/** 命令审计日志的截断长度，避免刷屏与泄露长内容。 */
const AUDIT_COMMAND_MAX_CHARS = 200;

export class DockerSandbox extends LocalSandbox {
  /**
   * @param id             沙箱 id（= 容器名）
   * @param containerName  目标容器名（docker exec 目标）
   * @param hostUserDataDir 宿主 user-data 根（= 容器内 /mnt/user-data 的挂载源），
   *                        用于把命令内宿主路径反向映射为容器内规范路径
   * @param waitReady      等待底层容器就绪（provider 异步创建，命令执行前需 await）
   * @param reprovision    容器消失时触发重建（provider 提供）
   * @param heartbeat      刷新活跃时间（provider 提供），防长任务被空闲回收误删
   */
  constructor(
    id: string,
    private readonly containerName: string,
    private readonly hostUserDataDir: string,
    private readonly waitReady: () => Promise<void>,
    private readonly reprovision: () => Promise<void>,
    private readonly heartbeat: () => void,
  ) {
    super(id);
  }

  override async executeCommand(command: string): Promise<string> {
    await this.waitReady();
    this.heartbeat();
    const { commandTimeoutMs, commandMaxRetries } = getDockerSandboxConfig();

    const containerCommand = this.toContainerPaths(command);
    // 命令审计：记容器名与命令首段（容器内路径已是 /mnt/user-data，不含宿主结构）。
    console.info(
      `${LOG} exec container=${this.containerName} cmd=${truncate(containerCommand, AUDIT_COMMAND_MAX_CHARS)}`,
    );
    const args = [
      'exec',
      '-w',
      CONTAINER_USER_DATA_ROOT,
      this.containerName,
      'sh',
      '-c',
      // command 作为单一参数交给容器内 sh -c，JS 侧不做任何 shell 拼接（防注入）。
      containerCommand,
    ];

    let result = await runDocker(args, { timeoutMs: commandTimeoutMs });

    // 容器消失（被回收/崩溃）时重建并有限次重试。
    for (let attempt = 0; attempt < commandMaxRetries; attempt += 1) {
      if (!isContainerMissing(result)) break;
      await this.reprovision();
      result = await runDocker(args, { timeoutMs: commandTimeoutMs });
    }

    this.heartbeat();
    return formatResult(result, commandTimeoutMs);
  }

  /**
   * 把命令字符串里的「宿主 user-data 根」整体替换为容器内 /mnt/user-data。
   * 工具层已将虚拟路径展开为宿主真实路径，此处做反向映射，使命令在容器内可寻址。
   */
  private toContainerPaths(command: string): string {
    return command.split(this.hostUserDataDir).join(CONTAINER_USER_DATA_ROOT);
  }
}

function isContainerMissing(result: DockerExecResult): boolean {
  if (result.exitCode === 0) return false;
  const stderr = result.stderr ?? '';
  return CONTAINER_MISSING_HINTS.some((hint) => stderr.includes(hint));
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function formatResult(result: DockerExecResult, commandTimeoutMs: number): string {
  let output = result.stdout ?? '';
  if (result.stderr) {
    output += output ? `\nStd Error:\n${result.stderr}` : result.stderr;
  }
  if (result.timedOut) {
    output += `\nTimed out after ${commandTimeoutMs}ms`;
  } else if (result.exitCode !== 0) {
    output += `\nExit Code: ${result.exitCode}`;
  }
  return output ? output : '(no output)';
}
