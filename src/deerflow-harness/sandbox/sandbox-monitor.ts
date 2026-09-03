/**
 * 沙箱监控聚合（只读）：把跨进程协调登记（thread↔container↔lastActiveAt↔refCount）
 * 与 docker stats 采样合并，供只读监控 API 查询多对话并行下的容器运行态。
 *
 * 仅 docker backend 有容器可观测；local backend 返回空快照。
 */

import { dockerStats, type DockerContainerStats } from './docker/docker-cli';
import { getSandboxCoordinator } from './docker/docker-coordinator';

export interface SandboxContainerSnapshot {
  threadId: string;
  containerName: string;
  lastActiveAt: number;
  refCount: number;
  /** 该容器空闲毫秒数（now - lastActiveAt）。 */
  idleMs: number;
  /** docker stats 采样；容器不存在或采样失败为 null。 */
  stats: DockerContainerStats | null;
}

export interface SandboxSnapshot {
  /** 是否为跨进程 Redis 协调模式（false 表示进程内降级）。 */
  distributed: boolean;
  /** 当前登记的容器数（活跃 + 空闲待回收）。 */
  containerCount: number;
  containers: SandboxContainerSnapshot[];
}

function isDockerBackend(): boolean {
  return (process.env.DEERFLOW_SANDBOX_BACKEND || 'local').trim().toLowerCase() === 'docker';
}

/**
 * 采集当前沙箱快照。includeStats=false 时跳过 docker stats（更快，仅看登记态）。
 */
export async function getSandboxSnapshot(includeStats = true): Promise<SandboxSnapshot> {
  if (!isDockerBackend()) {
    return { distributed: false, containerCount: 0, containers: [] };
  }

  const coordinator = getSandboxCoordinator();
  const registrations = await coordinator.listRegistrations();
  const now = Date.now();

  const containers: SandboxContainerSnapshot[] = [];
  for (const registration of registrations) {
    const stats =
      includeStats && registration.containerName.length > 0
        ? await dockerStats(registration.containerName)
        : null;
    containers.push({
      threadId: registration.threadId,
      containerName: registration.containerName,
      lastActiveAt: registration.lastActiveAt,
      refCount: registration.refCount,
      idleMs: Math.max(0, now - registration.lastActiveAt),
      stats,
    });
  }

  return {
    distributed: coordinator.isDistributed(),
    containerCount: containers.length,
    containers,
  };
}
