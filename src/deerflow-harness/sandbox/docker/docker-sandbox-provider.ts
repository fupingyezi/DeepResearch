/**
 * DockerSandboxProvider：按 threadId 管理长驻加固容器的生命周期。
 *
 * 生命周期：
 * - acquire(threadId)：同步登记并返回 sandboxId；容器创建是异步的（惰性、幂等），
 *   由后台 ensureContainer() 完成，命令执行前经 DockerSandbox.waitReady() 等待就绪。
 * - get(id)：取回对应 DockerSandbox 实例。
 * - release(id)：停止并删除容器，清理登记。
 *
 * 隔离与加固（创建容器时设定）：
 * - 资源限额：--memory / --cpus / --pids-limit
 * - 能力裁剪：--cap-drop ALL、--security-opt no-new-privileges
 * - 网络：--network（默认 bridge，可配 none 完全断网）
 * - 卷挂载：宿主 {base}/threads/{tid} 挂到容器同名绝对路径，保持路径契约一致
 * - 容器以 `sleep infinity` 常驻，命令通过 docker exec 投递
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { Sandbox } from '../sandbox';
import { SandboxProvider } from '../sandbox-provider';
import { getSandboxBaseDir, getThreadDirectories } from '../paths';
import { DockerSandbox } from './docker-sandbox';
import { getDockerSandboxConfig } from './docker-config';
import { runDocker } from './docker-cli';

const DEFAULT_THREAD_ID = 'default';

interface ContainerEntry {
  sandbox: DockerSandbox;
  containerName: string;
  threadDir: string;
  ready: Promise<void>;
}

export class DockerSandboxProvider extends SandboxProvider {
  private readonly entries = new Map<string, ContainerEntry>();

  acquire(threadId?: string): string {
    const tid = threadId && threadId.trim().length > 0 ? threadId.trim() : DEFAULT_THREAD_ID;
    const sandboxId = this.sandboxIdFor(tid);

    let entry = this.entries.get(sandboxId);
    if (!entry) {
      const { containerNamePrefix } = getDockerSandboxConfig();
      const containerName = `${containerNamePrefix}-${sanitizeName(tid)}`;
      // 挂载源 = 宿主 thread 根目录（含 user-data/{workspace,uploads,outputs}）。
      const threadDir = path.join(getSandboxBaseDir(), 'threads', tid);
      ensureHostDirs(tid);

      // 先建 entry 占位，ready Promise 供 sandbox 执行前等待；容器创建幂等。
      const ready = this.ensureContainer(containerName, threadDir);
      const sandbox = new DockerSandbox(
        sandboxId,
        containerName,
        getThreadDirectories(tid).workspace,
        () => ready,
      );
      entry = { sandbox, containerName, threadDir, ready };
      this.entries.set(sandboxId, entry);
    }
    return sandboxId;
  }

  get(sandboxId: string): Sandbox | null {
    return this.entries.get(sandboxId)?.sandbox ?? null;
  }

  release(sandboxId: string): void {
    const entry = this.entries.get(sandboxId);
    if (!entry) return;
    this.entries.delete(sandboxId);
    // 异步停止并删除容器（force 兜底），失败不抛出（释放为尽力而为）。
    void runDocker(['rm', '-f', entry.containerName], { timeoutMs: 30_000 }).catch(() => undefined);
  }

  /** 命令在加固容器内执行，具内核级隔离，属安全边界，故 bash 无需 host-bash 门控。 */
  isSecureIsolation(): boolean {
    return true;
  }

  private sandboxIdFor(threadId: string): string {
    const { containerNamePrefix } = getDockerSandboxConfig();
    return `${containerNamePrefix}-${sanitizeName(threadId)}`;
  }

  /**
   * 幂等地确保容器存在且在运行：
   * - 若同名容器已存在（Up/Exited）则复用（Exited 时启动）。
   * - 否则以加固参数创建并常驻。
   */
  private async ensureContainer(containerName: string, threadDir: string): Promise<void> {
    const cfg = getDockerSandboxConfig();

    const inspect = await runDocker(
      ['inspect', '-f', '{{.State.Running}}', containerName],
      { timeoutMs: 15_000 },
    );
    if (inspect.exitCode === 0) {
      const running = inspect.stdout.trim() === 'true';
      if (running) return;
      const started = await runDocker(['start', containerName], { timeoutMs: 30_000 });
      if (started.exitCode === 0) return;
      // 启动失败则清理后重建。
      await runDocker(['rm', '-f', containerName], { timeoutMs: 30_000 }).catch(() => undefined);
    }

    const runArgs = [
      'run',
      '-d',
      '--name',
      containerName,
      // 卷挂载：宿主 thread 目录 -> 容器同名绝对路径，保持路径契约一致。
      '-v',
      `${threadDir}:${threadDir}`,
      '-w',
      threadDir,
      '--memory',
      cfg.memoryLimit,
      '--cpus',
      cfg.cpuLimit,
      '--pids-limit',
      String(cfg.pidsLimit),
      '--network',
      cfg.networkMode,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      // 降权：容器内以非 root 运行（纵深防御，配合 cap-drop / no-new-privileges）。
      '--user',
      cfg.runAsUser,
      cfg.image,
      'sleep',
      'infinity',
    ];

    const created = await runDocker(runArgs, { timeoutMs: 120_000 });
    if (created.exitCode !== 0) {
      throw new Error(
        `Failed to start docker sandbox container "${containerName}": ${created.stderr || created.stdout}`,
      );
    }
  }
}

/** 容器名合法化：仅保留 [a-zA-Z0-9_.-]，其余替换为 '-'。 */
function sanitizeName(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^-+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : 'thread';
}

/** 预建宿主 thread 目录，保证 bind mount 源存在且容器内可见 workspace 等子目录。 */
function ensureHostDirs(threadId: string): void {
  const dirs = getThreadDirectories(threadId);
  for (const dir of [dirs.userData, dirs.workspace, dirs.uploads, dirs.outputs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
