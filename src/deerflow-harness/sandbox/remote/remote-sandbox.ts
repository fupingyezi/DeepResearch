/**
 * RemoteSandbox：在远程主机（SSH）上执行命令与文件 IO。
 *
 * 与 DockerSandbox 的关键差异：容器通过 bind mount 让宿主与容器看到同一份文件，
 * 因此 Docker 只需重写 executeCommand；而远程主机的文件系统与宿主完全分离，
 * 故本类**全部 IO 方法**都要重写为经 SSH 往返。
 *
 * 路径语义：工具层传入的是「远程真实路径」（由 provider 的 threadDirectories 提供，
 * 而非宿主 `.sandbox` 路径）。虚拟路径映射 / 命令路径校验 / 输出脱敏都在工具层完成，
 * 对后端无感。
 *
 * 隔离边界：远程主机即边界 → `isSecureIsolation() === true`，bash 不受
 * DEERFLOW_ALLOW_HOST_BASH 门控（与 docker 同语义）。
 */

import {
  Sandbox,
  type GlobOptions,
  type GlobResult,
  type GrepOptions,
  type GrepResult,
} from '../sandbox';
import { shellQuote, type SshConnection } from './ssh-connection-manager';
import {
  getRemoteSandboxConfig,
  type RemoteSandboxConfig,
  type RemoteThreadDirectories,
} from './remote-config';

/** 远程 grep 单行输出的解析正则：`path:lineNumber:content`。 */
const GREP_LINE_PATTERN = /^(.*?):(\d+):(.*)$/;

export class RemoteSandbox extends Sandbox {
  /**
   * @param connection 该 thread 的 SSH 连接（provider 经连接管理器提供）
   * @param dirs       远程 thread 目录（虚拟路径映射的目标）
   * @param config     运行配置；缺省从 env 读取（测试可显式注入，避免依赖环境）
   */
  constructor(
    id: string,
    private readonly connection: SshConnection,
    private readonly dirs: RemoteThreadDirectories,
    private readonly config: RemoteSandboxConfig = getRemoteSandboxConfig(),
  ) {
    super(id);
  }

  override async executeCommand(command: string): Promise<string> {
    // 与 docker 后端同范式：命令作为 sh -c 的单一参数投递，JS 侧不做 shell 拼接。
    // 工具层已把虚拟路径替换为远程真实路径并 cd 到 workspace。
    const outcome = await this.connection.exec(command);
    let output = outcome.stdout;
    if (outcome.stderr) {
      output += output ? `\nStd Error:\n${outcome.stderr}` : outcome.stderr;
    }
    if (outcome.timedOut) {
      output += `\nTimed out after ${this.config.commandTimeoutMs}ms`;
    } else if (outcome.exitCode !== 0) {
      output += `\nExit Code: ${outcome.exitCode}`;
    }
    return output ? output : '(no output)';
  }

  override async readFile(path: string): Promise<string> {
    // base64 往返：避免二进制/编码/换行被 SSH 文本通道改写
    const outcome = await this.connection.exec(`base64 ${shellQuote(path)}`);
    if (outcome.exitCode !== 0) {
      throw new Error(`remote read failed: ${outcome.stderr.trim() || path}`);
    }
    return Buffer.from(outcome.stdout.replace(/\s+/g, ''), 'base64').toString('utf-8');
  }

  override async writeFile(path: string, content: string, append = false): Promise<void> {
    const { maxWriteBytes } = this.config;
    const bytes = Buffer.byteLength(content, 'utf-8');
    if (bytes > maxWriteBytes) {
      throw new Error(
        `remote write rejected: ${bytes} bytes exceeds DEERFLOW_REMOTE_MAX_WRITE_BYTES (${maxWriteBytes})`,
      );
    }
    await this.connection.writeFile(path, content, append);
  }

  override async listDir(path: string, maxDepth = 2): Promise<string[]> {
    const depth = Math.max(1, maxDepth);
    // 与 list-dir.ts 的树形语义对齐：目录加尾斜杠，缺省深度 2
    const command =
      `find ${shellQuote(path)} -maxdepth ${depth} -mindepth 1 | sort | ` +
      `while IFS= read -r entry; do ` +
      `if [ -d "$entry" ]; then printf '%s/\\n' "$entry"; else printf '%s\\n' "$entry"; fi; done`;
    const outcome = await this.connection.exec(command);
    if (outcome.exitCode !== 0 && !outcome.stdout) {
      throw new Error(`remote list failed: ${outcome.stderr.trim() || path}`);
    }
    return outcome.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  override async glob(path: string, pattern: string, opts: GlobOptions = {}): Promise<GlobResult> {
    const maxResults = opts.maxResults ?? 200;
    const typeFilter = opts.includeDirs ? '' : ' -type f';
    // 取 maxResults + 1 条用于判断是否被截断（与 search.ts 语义一致）
    const command = `find ${shellQuote(path)}${typeFilter} -name ${shellQuote(pattern)} | sort | head -n ${maxResults + 1}`;
    const outcome = await this.connection.exec(command);
    const all = outcome.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const truncated = all.length > maxResults;
    const matches = truncated ? all.slice(0, maxResults) : all;
    // 与本地实现一致：glob 返回虚拟路径（调用方随后用 path-utils 反查/脱敏）
    return { matches: matches.map((match) => this.toVirtual(match)), truncated };
  }

  override async grep(path: string, pattern: string, opts: GrepOptions = {}): Promise<GrepResult> {
    const maxResults = opts.maxResults ?? 100;
    const flags = ['-rI', '-n'];
    if (!opts.caseSensitive) flags.push('-i');
    if (opts.literal) flags.push('-F');
    if (opts.glob) flags.push(`--include=${opts.glob}`);

    const command = `grep ${flags.join(' ')} -- ${shellQuote(pattern)} ${shellQuote(path)} | head -n ${maxResults + 1}`;
    const outcome = await this.connection.exec(command);
    // grep 未命中时退出码为 1，属正常情况
    const lines = outcome.stdout.split('\n').filter((line) => line.length > 0);
    const truncated = lines.length > maxResults;
    const kept = truncated ? lines.slice(0, maxResults) : lines;

    const matches = kept
      .map((line) => {
        const parsed = line.match(GREP_LINE_PATTERN);
        if (!parsed) return null;
        return {
          path: this.toVirtual(parsed[1]),
          lineNumber: Number.parseInt(parsed[2], 10),
          line: parsed[3],
        };
      })
      .filter(
        (match): match is { path: string; lineNumber: number; line: string } => match !== null,
      );

    return { matches, truncated };
  }

  /** 远程真实路径 → 虚拟路径（供上层统一脱敏 / 展示）。 */
  private toVirtual(remotePath: string): string {
    if (remotePath.startsWith(this.dirs.userData)) {
      return `/mnt/user-data${remotePath.slice(this.dirs.userData.length)}`;
    }
    return remotePath;
  }
}
