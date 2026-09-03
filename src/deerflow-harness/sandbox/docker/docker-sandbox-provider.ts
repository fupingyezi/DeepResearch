/**
 * DockerSandboxProvider：按 threadId 管理长驻加固容器，支撑多对话并行编排。
 *
 * 生命周期模型（长驻 + 空闲回收，用户选定）：
 * - acquire(threadId)：同步登记并返回 sandboxId；命中已有容器直接复用并 incRef，
 *   未命中则经协调模块占位（容器级并发闸门），必要时 LRU 淘汰空闲容器腾位。
 *   容器创建异步（惰性、幂等），命令执行前经 DockerSandbox.waitReady() 等待就绪。
 * - markIdle(id)：run/agent 结束（sandbox-middleware.afterAgent）调用，decRef；
 *   归零容器交空闲回收器按 idleTimeout 统一回收，不立即删。
 * - heartbeat(id)：命令执行时刷新活跃时间，防长任务被误回收。
 * - release(id)：显式销毁（deleteThread）时停止删除容器并清计数/登记。
 *
 * 跨进程协调（单机多进程 / PM2）：以 Docker daemon 为容器真相源、Redis 为协调层
 * （容器计数 / thread→container 登记 / lastActiveAt / refCount / 分布式锁）。
 * Redis 不可用时协调模块自动降级进程内，不阻断对话。
 *
 * 隔离与加固（创建容器时设定）：
 * - 资源：--memory / --memory-swap / --cpus / --pids-limit
 * - 能力：--cap-drop ALL、--security-opt no-new-privileges、--user 非 root
 * - 网络：--network（默认 bridge，可配 none 断网）
 * - 文件系统：宿主 {threadDir}/user-data 挂到容器 /mnt/user-data（消除宿主真实路径泄露）；
 *   可选 --read-only 根 + tmpfs 提供最小可写区
 */

import * as fs from 'node:fs';

import { Sandbox } from '../sandbox';
import { SandboxProvider } from '../sandbox-provider';
import { getThreadDirectories } from '../paths';
import { DockerSandbox } from './docker-sandbox';
import { CONTAINER_USER_DATA_ROOT, getDockerSandboxConfig } from './docker-config';
import { dockerPsByPrefix, runDocker } from './docker-cli';
import { getSandboxCoordinator, type SandboxCoordinator } from './docker-coordinator';

const DEFAULT_THREAD_ID = 'default';
const LOG = '[docker-sandbox]';

interface ContainerEntry {
  sandbox: DockerSandbox;
  containerName: string;
  threadId: string;
  ready: Promise<void>;
}

export class DockerSandboxProvider extends SandboxProvider {
  private readonly entries = new Map<string, ContainerEntry>();
  private readonly coordinator: SandboxCoordinator = getSandboxCoordinator();
  private reaperTimer: NodeJS.Timeout | null = null;
  private reconciled = false;

  constructor() {
    super();
    this.startReaper();
    // 启动对账异步进行，不阻塞首个 acquire。
    void this.reconcile();
  }

  acquire(threadId?: string): string {
    const tid = threadId && threadId.trim().length > 0 ? threadId.trim() : DEFAULT_THREAD_ID;
    const sandboxId = this.sandboxIdFor(tid);

    const existing = this.entries.get(sandboxId);
    if (existing) {
      // 幂等复用：仅刷新活跃时间；引用计数由 middleware retain/markIdle 成对驱动，
      // 不随每次 acquire（含 subagent 惰性 acquire）累加，避免 refCount 泄漏。
      void this.coordinator.touch(tid);
      return sandboxId;
    }

    const { containerNamePrefix } = getDockerSandboxConfig();
    const containerName = `${containerNamePrefix}-${sanitizeName(tid)}`;
    ensureHostDirs(tid);

    // 先建 entry 占位，ready Promise 供 sandbox 执行前等待；容器创建幂等 + 闸门。
    const ready = this.provisionContainer(tid, containerName);
    const sandbox = new DockerSandbox(
      sandboxId,
      containerName,
      getThreadDirectories(tid).userData,
      () => ready,
      () => this.reprovision(sandboxId),
      () => this.coordinator.touch(tid),
    );
    this.entries.set(sandboxId, {
      sandbox,
      containerName,
      threadId: tid,
      ready,
    });
    return sandboxId;
  }

  get(sandboxId: string): Sandbox | null {
    return this.entries.get(sandboxId)?.sandbox ?? null;
  }

  retain(sandboxId: string): void {
    const entry = this.entries.get(sandboxId);
    if (!entry) return;
    void this.coordinator.incRef(entry.threadId);
  }

  markIdle(sandboxId: string): void {
    const entry = this.entries.get(sandboxId);
    if (!entry) return;
    void this.coordinator.decRef(entry.threadId);
  }

  heartbeat(sandboxId: string): void {
    const entry = this.entries.get(sandboxId);
    if (!entry) return;
    void this.coordinator.touch(entry.threadId);
  }

  release(sandboxId: string): void {
    const entry = this.entries.get(sandboxId);
    if (!entry) return;
    this.entries.delete(sandboxId);
    void this.destroyContainer(entry.threadId, entry.containerName);
  }

  releaseByThreadId(threadId?: string): void {
    const tid = threadId && threadId.trim().length > 0 ? threadId.trim() : DEFAULT_THREAD_ID;
    const sandboxId = this.sandboxIdFor(tid);
    const entry = this.entries.get(sandboxId);
    this.entries.delete(sandboxId);
    // sandboxId === containerName（同一命名规则）；即使本进程无 entry（他进程创建）
    // 也能按名销毁并清协调登记，保证 deleteThread 跨进程一致。
    const containerName = entry?.containerName ?? sandboxId;
    void this.destroyContainer(tid, containerName);
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
   * 容器级并发闸门 + 占位 + 创建：
   * - 经协调模块 tryReserveContainer 原子占位；失败则 LRU 淘汰一个空闲容器腾位后重试。
   * - 仍无名额则抛可读错误（bash 工具转为 status='error' ToolMessage）。
   * - 占位成功后在 acquire 分布式锁保护下创建容器并登记（防多进程重复建同名容器）。
   */
  private async provisionContainer(threadId: string, containerName: string): Promise<void> {
    const cfg = getDockerSandboxConfig();

    let reserved = await this.coordinator.tryReserveContainer(cfg.maxLiveContainers);
    if (!reserved) {
      const evicted = await this.evictOneIdle();
      if (evicted) {
        reserved = await this.coordinator.tryReserveContainer(cfg.maxLiveContainers);
      }
    }
    if (!reserved) {
      throw new Error(
        `Sandbox capacity reached (max ${cfg.maxLiveContainers} live containers). ` +
          `Please retry shortly.`,
      );
    }

    // 分布式锁下创建：抢锁失败说明另一进程正在建同名容器，等待其 ready 即可复用。
    const userDataDir = getThreadDirectories(threadId).userData;
    const created = await this.coordinator.withAcquireLock(
      containerName,
      cfg.acquireLockTtlMs,
      async () => {
        await this.ensureContainer(containerName, userDataDir);
        await this.coordinator.register(threadId, containerName);
        return true;
      },
    );

    if (created === null) {
      // 未抢到锁：容器由他进程创建并登记（已占名额）；本进程归还刚占的名额，
      // 避免重复计数，仅轮询等待容器就绪（daemon 为真相源）。引用计数由 middleware
      // retain/markIdle 成对驱动，此处不额外累加。
      await this.coordinator.releaseContainer();
      await this.waitForForeignContainer(containerName);
    }
  }

  /** 命令执行发现容器消失时触发：重建容器（不重复占名额，因登记仍在）。 */
  private async reprovision(sandboxId: string): Promise<void> {
    const entry = this.entries.get(sandboxId);
    if (!entry) return;
    const userDataDir = getThreadDirectories(entry.threadId).userData;
    await this.ensureContainer(entry.containerName, userDataDir);
    await this.coordinator.touch(entry.threadId);
  }

  /** LRU 淘汰：回收一个 refCount=0 且最久未活跃的空闲容器，腾出名额。 */
  private async evictOneIdle(): Promise<boolean> {
    // idleTimeoutMs 传 0：容器压力下允许淘汰任何空闲容器（不必等到超时）。
    const candidates = await this.coordinator.listIdleCandidates(0);
    if (candidates.length === 0) return false;
    candidates.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    const victim = candidates[0];
    await this.destroyContainer(victim.threadId, victim.containerName);
    // 淘汰他 thread 的容器时，清理本进程可能持有的对应 entry。
    const victimSandboxId = this.sandboxIdFor(victim.threadId);
    this.entries.delete(victimSandboxId);
    console.info(`${LOG} evicted idle container=${victim.containerName} for capacity`);
    return true;
  }

  /**
   * 停止删除容器 + 清登记 + 释放计数（尽力而为，失败不抛）。
   * 仅当登记确实存在时才 releaseContainer，防止对未占名额的 threadId 误减导致计数漂移。
   */
  private async destroyContainer(threadId: string, containerName: string): Promise<void> {
    const registration = await this.coordinator.getRegistration(threadId).catch(() => null);
    await runDocker(['rm', '-f', containerName], { timeoutMs: 30_000 }).catch(() => undefined);
    if (registration) {
      await this.coordinator.unregister(threadId).catch(() => undefined);
      await this.coordinator.releaseContainer().catch(() => undefined);
    }
  }

  /** 轮询等待他进程创建的同名容器进入 Running（最多约 60s）。 */
  private async waitForForeignContainer(containerName: string): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const inspect = await runDocker(['inspect', '-f', '{{.State.Running}}', containerName], {
        timeoutMs: 10_000,
      });
      if (inspect.exitCode === 0 && inspect.stdout.trim() === 'true') return;
      await delay(1000);
    }
  }

  /**
   * 幂等地确保容器存在且在运行：
   * - 同名容器已存在（Up/Exited）则复用（Exited 时启动）。
   * - 否则以加固参数创建并常驻。
   */
  private async ensureContainer(containerName: string, userDataDir: string): Promise<void> {
    const cfg = getDockerSandboxConfig();

    const inspect = await runDocker(['inspect', '-f', '{{.State.Running}}', containerName], {
      timeoutMs: 15_000,
    });
    if (inspect.exitCode === 0) {
      const running = inspect.stdout.trim() === 'true';
      if (running) return;
      const started = await runDocker(['start', containerName], { timeoutMs: 30_000 });
      if (started.exitCode === 0) return;
      await runDocker(['rm', '-f', containerName], { timeoutMs: 30_000 }).catch(() => undefined);
    }

    const runArgs = buildRunArgs(cfg, containerName, userDataDir);

    const created = await runDocker(runArgs, { timeoutMs: 120_000 });
    if (created.exitCode !== 0) {
      throw new Error(
        `Failed to start docker sandbox container "${containerName}": ${created.stderr || created.stdout}`,
      );
    }
  }

  /** 空闲回收器：周期扫描，抢回收锁后回收 refCount=0 且超时的容器。 */
  private startReaper(): void {
    if (this.reaperTimer) return;
    const cfg = getDockerSandboxConfig();
    this.reaperTimer = setInterval(() => {
      void this.reapIdle();
    }, cfg.idleReapIntervalMs);
    // 回收器不应阻止进程退出。
    if (typeof this.reaperTimer.unref === 'function') this.reaperTimer.unref();
  }

  private async reapIdle(): Promise<void> {
    const cfg = getDockerSandboxConfig();
    const locked = await this.coordinator.tryReapLock(cfg.reapLockTtlMs);
    if (!locked) return;
    try {
      const candidates = await this.coordinator.listIdleCandidates(cfg.idleTimeoutMs);
      for (const candidate of candidates) {
        await this.destroyContainer(candidate.threadId, candidate.containerName);
        this.entries.delete(this.sandboxIdFor(candidate.threadId));
        console.info(`${LOG} reaped idle container=${candidate.containerName}`);
      }
    } finally {
      await this.coordinator.releaseReapLock();
    }
  }

  /**
   * 启动对账：以 docker ps（daemon 真相源）与 Redis 登记对账——
   * - 有容器但无登记且非本进程持有 → 孤儿容器（宿主重启/进程崩溃残留），rm -f 清理。
   * - 有登记但容器已消失 → 清登记与计数，防计数漂移。
   * 仅执行一次；抢回收锁复用其互斥，避免多进程重复对账。
   */
  private async reconcile(): Promise<void> {
    if (this.reconciled) return;
    this.reconciled = true;
    const cfg = getDockerSandboxConfig();
    const locked = await this.coordinator.tryReapLock(cfg.reapLockTtlMs);
    if (!locked) return;
    try {
      const liveNames = new Set(await dockerPsByPrefix(cfg.containerNamePrefix));
      const registrations = await this.coordinator.listRegistrations();
      const registeredNames = new Set(registrations.map((r) => r.containerName));

      // 登记存在但容器已消失：清登记与计数。
      for (const reg of registrations) {
        if (!liveNames.has(reg.containerName)) {
          await this.coordinator.unregister(reg.threadId).catch(() => undefined);
          await this.coordinator.releaseContainer().catch(() => undefined);
          console.info(`${LOG} reconcile: cleared stale registration=${reg.containerName}`);
        }
      }

      // 容器存在但无登记：孤儿容器（如宿主重启后残留），直接销毁。
      for (const name of liveNames) {
        if (!registeredNames.has(name)) {
          await runDocker(['rm', '-f', name], { timeoutMs: 30_000 }).catch(() => undefined);
          console.info(`${LOG} reconcile: removed orphan container=${name}`);
        }
      }
    } finally {
      await this.coordinator.releaseReapLock();
    }
  }
}

/** 构建 docker run 参数数组（加固 + 卷挂载到容器内规范路径）。 */
function buildRunArgs(
  cfg: ReturnType<typeof getDockerSandboxConfig>,
  containerName: string,
  userDataDir: string,
): string[] {
  const args = [
    'run',
    '-d',
    '--name',
    containerName,
    // 卷挂载：宿主 user-data -> 容器内规范路径 /mnt/user-data，消除宿主真实路径泄露，
    // 且与工具虚拟路径契约天然一致。
    '-v',
    `${userDataDir}:${CONTAINER_USER_DATA_ROOT}`,
    '-w',
    CONTAINER_USER_DATA_ROOT,
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
    '--user',
    cfg.runAsUser,
  ];

  if (cfg.memorySwapLimit.length > 0) {
    args.push('--memory-swap', cfg.memorySwapLimit);
  }
  if (cfg.readOnlyRootfs) {
    args.push('--read-only');
    if (cfg.tmpfsSize.length > 0) {
      // 只读根下提供最小可写临时区（不落宿主盘，容器销毁即失）。
      args.push('--tmpfs', `/tmp:size=${cfg.tmpfsSize}`);
    }
  }

  args.push(cfg.image, 'sleep', 'infinity');
  return args;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
