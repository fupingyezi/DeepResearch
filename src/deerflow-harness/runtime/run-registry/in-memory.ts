/**
 * InMemoryRunRegistry —— RunRegistry 的进程内实现。
 *
 * 单进程里登记表与 run 执行体必然同进程：requestCancel 直接同步回调注册的
 * handler，命中即真正 abort。owner 字段在本实现里仅作记录，无路由作用。
 */

import type { RunOwnerInfo, RunRegistry } from '../contracts';

export class InMemoryRunRegistry implements RunRegistry {
  private readonly runs = new Map<string, RunOwnerInfo>();
  /** 反向索引：thread_id → 在跑的 run_id 集合，供 listByThread O(1) 而非全表过滤。 */
  private readonly byThread = new Map<string, Set<string>>();
  private readonly cancelHandlers: Array<(runId: string, reason: string) => number> = [];

  async register(info: RunOwnerInfo): Promise<void> {
    this.runs.set(info.runId, info);
    const set = this.byThread.get(info.threadId);
    if (set) set.add(info.runId);
    else this.byThread.set(info.threadId, new Set([info.runId]));
  }

  async unregister(runId: string): Promise<void> {
    const info = this.runs.get(runId);
    if (!info) return;
    this.runs.delete(runId);
    const set = this.byThread.get(info.threadId);
    set?.delete(runId);
    // 空集合一并清掉：thread 删完后索引不残留
    if (set && set.size === 0) this.byThread.delete(info.threadId);
  }

  async ownerOf(runId: string): Promise<RunOwnerInfo | null> {
    return this.runs.get(runId) ?? null;
  }

  async listByThread(threadId: string): Promise<RunOwnerInfo[]> {
    const set = this.byThread.get(threadId);
    if (!set) return [];
    const out: RunOwnerInfo[] = [];
    for (const runId of set) {
      const info = this.runs.get(runId);
      if (info) out.push(info);
    }
    return out;
  }

  async requestCancel(runId: string, reason: string): Promise<number> {
    let hits = 0;
    for (const handler of this.cancelHandlers) hits += handler(runId, reason);
    return hits;
  }

  onCancelRequest(handler: (runId: string, reason: string) => number): void {
    this.cancelHandlers.push(handler);
  }

  isDistributed(): boolean {
    return false;
  }
}
