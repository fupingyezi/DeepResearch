/**
 * DockerSandbox：在独立容器内执行 bash，实现内核级隔离。
 *
 * 设计要点（最小改动 + 契约一致）：
 * - 文件读写/检索（read/write/list/glob/grep）直接复用 LocalSandbox：宿主的 thread
 *   目录被 bind mount 进容器「同名绝对路径」，宿主侧文件操作 == 容器内可见内容，
 *   因此无需重复实现，也天然与容器内 bash 看到同一份文件。
 * - 仅重写 executeCommand：命令通过 `docker exec` 投递到本 thread 的长驻容器内执行，
 *   享有资源限额 / 能力裁剪 / 网络隔离（由 provider 创建容器时设定）。
 *
 * 路径契约：入参路径为工具层解析后的宿主真实绝对路径，且必然落在挂载点之内，
 * 故可直接作为容器内的 -w 工作目录使用。
 */

import { LocalSandbox } from '../local/local-sandbox';
import { runDocker } from './docker-cli';
import { getDockerSandboxConfig } from './docker-config';

export class DockerSandbox extends LocalSandbox {
  /**
   * @param id            沙箱 id（= 容器名）
   * @param containerName 目标容器名（docker exec 目标）
   * @param workdir       容器内默认工作目录（= 宿主挂载点，已存在）
   * @param waitReady     等待底层容器就绪（provider 异步创建，命令执行前需 await）
   */
  constructor(
    id: string,
    private readonly containerName: string,
    private readonly workdir: string,
    private readonly waitReady: () => Promise<void>,
  ) {
    super(id);
  }

  override async executeCommand(command: string): Promise<string> {
    await this.waitReady();
    const { commandTimeoutMs } = getDockerSandboxConfig();

    // command 作为单一参数交给容器内 sh -c，JS 侧不做任何 shell 拼接（防注入）。
    const args = [
      'exec',
      '-w',
      this.workdir,
      this.containerName,
      'sh',
      '-c',
      command,
    ];

    const result = await runDocker(args, { timeoutMs: commandTimeoutMs });

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
}
