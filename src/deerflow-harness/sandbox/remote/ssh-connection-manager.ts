/**
 * SshConnectionManager：per-thread SSH 连接池（每 thread 一条长连接）。
 *
 * 职责：
 * - acquire：幂等复用同一 thread 的连接；首次建立时创建远程 thread 目录。
 * - 引用计数 + 空闲回收：refCount 归零且空闲超时后关闭连接（定时器 unref，
 *   不阻塞进程退出）。
 * - 并发闸门：进程内信号量限制活跃连接数（超限排队），避免单进程打爆远程主机。
 *
 * 与 docker 后端的差异：不做跨进程协调（Redis），多进程部署时上限按进程独立计。
 */

import { Client, type ConnectConfig } from 'ssh2';

import {
  getRemoteSandboxConfig,
  resolveRemotePrivateKey,
  type RemoteSandboxConfig,
} from './remote-config';

/** 一条已就绪的 SSH 连接句柄。 */
export interface SshConnection {
  threadId: string;
  /** 执行命令；返回 stdout/stderr/exitCode/timeout 结构化结果。 */
  exec(command: string, options?: { timeoutMs?: number }): Promise<ExecOutcome>;
  /** 写文件（走 stdin，避免命令行长度限制与转义问题）。 */
  writeFile(remotePath: string, content: string, append: boolean): Promise<void>;
}

export interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** 命令耗时（毫秒），用于日志与排查。 */
  durationMs: number;
}

const LOG = '[remote-sandbox]';
/** exec 输出的内存上限（单次命令），防远程大输出打爆进程内存。 */
const EXEC_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

interface ConnectionEntry {
  threadId: string;
  client: Client;
  /** 就绪 Promise（客户端 connect 成功 + 目录已创建）。 */
  ready: Promise<void>;
  refCount: number;
  lastActiveAt: number;
}

export class SshConnectionManager {
  private readonly connections = new Map<string, ConnectionEntry>();
  /** 正在建立中的连接（防并发重复建连）。 */
  private readonly pending = new Map<string, Promise<ConnectionEntry>>();
  private readonly config: RemoteSandboxConfig;
  private reapTimer: NodeJS.Timeout | null = null;

  // 进程内并发闸门
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(config?: RemoteSandboxConfig) {
    this.config = config ?? getRemoteSandboxConfig();
  }

  /** 获取（或建立）thread 的连接，引用计数 +1。 */
  async acquire(threadId: string): Promise<SshConnection> {
    const existing = this.connections.get(threadId);
    if (existing) {
      existing.refCount += 1;
      existing.lastActiveAt = Date.now();
      await existing.ready;
      return this.toConnection(existing);
    }

    const pendingEntry = this.pending.get(threadId);
    if (pendingEntry) {
      const entry = await pendingEntry;
      entry.refCount += 1;
      entry.lastActiveAt = Date.now();
      return this.toConnection(entry);
    }

    await this.acquireSlot();
    const creating = this.createEntry(threadId);
    this.pending.set(threadId, creating);
    try {
      const entry = await creating;
      entry.refCount = 1;
      this.connections.set(threadId, entry);
      this.ensureReaper();
      return this.toConnection(entry);
    } catch (e) {
      this.releaseSlot();
      throw e;
    } finally {
      this.pending.delete(threadId);
    }
  }

  /** 引用计数 -1；归零后交由空闲回收器处理（不立即断开，吸收同 thread 后续 run）。 */
  markIdle(threadId: string): void {
    const entry = this.connections.get(threadId);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastActiveAt = Date.now();
  }

  /** 刷新活跃时间（命令执行前后调用），防长任务期间被空闲回收。 */
  heartbeat(threadId: string): void {
    const entry = this.connections.get(threadId);
    if (entry) entry.lastActiveAt = Date.now();
  }

  /** 显式关闭 thread 连接（如 deleteThread）。 */
  releaseByThreadId(threadId: string): void {
    const entry = this.connections.get(threadId);
    if (!entry) return;
    this.connections.delete(threadId);
    try {
      entry.client.end();
    } catch (e) {
      console.warn(`${LOG} failed to close connection for ${threadId}:`, (e as Error)?.message);
    }
    this.releaseSlot();
  }

  /** 当前活跃连接数（监控用）。 */
  get activeConnections(): number {
    return this.connections.size;
  }

  /** thread ↔ 连接 快照（监控用）。 */
  snapshot(): Array<{ threadId: string; refCount: number; idleMs: number }> {
    const now = Date.now();
    return [...this.connections.values()].map((entry) => ({
      threadId: entry.threadId,
      refCount: entry.refCount,
      idleMs: now - entry.lastActiveAt,
    }));
  }

  /** 关闭全部连接（进程退出 / 测试清理）。 */
  shutdown(): void {
    for (const threadId of [...this.connections.keys()]) {
      this.releaseByThreadId(threadId);
    }
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
  }

  // —— 内部 ——

  private async createEntry(threadId: string): Promise<ConnectionEntry> {
    const client = new Client();
    const entry: ConnectionEntry = {
      threadId,
      client,
      ready: Promise.resolve(),
      refCount: 0,
      lastActiveAt: Date.now(),
    };

    const connectConfig: ConnectConfig = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      privateKey: resolveRemotePrivateKey(this.config),
      keepaliveInterval: this.config.keepaliveIntervalMs,
      readyTimeout: this.config.commandTimeoutMs,
      ...(this.config.passphrase ? { passphrase: this.config.passphrase } : {}),
    };

    entry.ready = new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve());
      client.once('error', (err) => reject(err));
    });

    client.connect(connectConfig);
    await entry.ready;

    // 连接建立后创建 thread 目录（幂等），后续读写无需再判断
    const dirs = [
      `${this.config.baseDir}/threads/${threadId}/user-data/workspace`,
      `${this.config.baseDir}/threads/${threadId}/user-data/uploads`,
      `${this.config.baseDir}/threads/${threadId}/user-data/outputs`,
    ];
    const outcome = await this.execOnClient(client, `mkdir -p ${dirs.map(shellQuote).join(' ')}`);
    if (outcome.exitCode !== 0) {
      client.end();
      throw new Error(`${LOG} failed to prepare remote directories: ${outcome.stderr}`);
    }

    return entry;
  }

  private toConnection(entry: ConnectionEntry): SshConnection {
    return {
      threadId: entry.threadId,
      exec: (command, options) => this.execOnClient(entry.client, command, options),
      writeFile: (remotePath, content, append) =>
        this.writeOnClient(entry.client, remotePath, content, append),
    };
  }

  private execOnClient(
    client: Client,
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<ExecOutcome> {
    const timeoutMs = options?.timeoutMs ?? this.config.commandTimeoutMs;
    const startedAt = Date.now();

    return new Promise<ExecOutcome>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        resolve({ stdout, stderr, exitCode, timedOut, durationMs: Date.now() - startedAt });
      };

      client.exec(command, (err, stream) => {
        if (err) {
          finish(1);
          stderr += err.message;
          return;
        }

        const timer = setTimeout(() => {
          timedOut = true;
          stream.close();
          finish(124);
        }, timeoutMs);

        stream.on('data', (chunk: Buffer) => {
          if (stdout.length < EXEC_MAX_OUTPUT_BYTES) stdout += chunk.toString('utf-8');
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < EXEC_MAX_OUTPUT_BYTES) stderr += chunk.toString('utf-8');
        });
        stream.on('close', (code: number | null) => {
          clearTimeout(timer);
          finish(typeof code === 'number' ? code : 0);
        });
      });
    });
  }

  /** 经 stdin 写入内容（`sh -c 'cat > path'`），避免命令行长度与转义问题。 */
  private writeOnClient(
    client: Client,
    remotePath: string,
    content: string,
    append: boolean,
  ): Promise<void> {
    const redirect = append ? '>>' : '>';
    const command = `mkdir -p ${shellQuote(dirnamePosix(remotePath))} && cat ${redirect} ${shellQuote(remotePath)}`;

    return new Promise<void>((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        let stderr = '';
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8');
        });
        stream.on('close', (code: number | null) => {
          if (code === 0) resolve();
          else reject(new Error(`remote write failed (code=${code}): ${stderr}`));
        });
        stream.end(Buffer.from(content, 'utf-8'));
      });
    });
  }

  private ensureReaper(): void {
    if (this.reapTimer) return;
    this.reapTimer = setInterval(
      () => this.reapIdle(),
      Math.max(5_000, this.config.idleTimeoutMs / 4),
    );
    // 不阻塞进程退出
    this.reapTimer.unref?.();
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const entry of [...this.connections.values()]) {
      if (entry.refCount === 0 && now - entry.lastActiveAt >= this.config.idleTimeoutMs) {
        console.info(`${LOG} reaping idle connection thread=${entry.threadId}`);
        this.releaseByThreadId(entry.threadId);
      }
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.activeCount < this.config.maxConcurrent) {
      this.activeCount += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.activeCount += 1;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}

/** posix 目录名（不依赖宿主平台语义，远程始终是 posix）。 */
function dirnamePosix(remotePath: string): string {
  const index = remotePath.lastIndexOf('/');
  return index <= 0 ? '/' : remotePath.slice(0, index);
}

/**
 * 单引号包裹并转义（POSIX shell 最安全的最小转义）：
 * 把内部的 `'` 替换为 `'\''`，其余字符原样保留在单引号内。
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}
