/**
 * Memory update queue。
 *
 * 行为：
 * - `add()`：debounce 入队；同一 thread_id 的 context 会被合并（保留最新 messages，
 *   correction/reinforcement 信号取 OR）。
 * - `addNowait()` / `flushNowait()`：以 0 延迟立即调度处理。
 * - `flush()`：取消计时器并立即同步处理（用于优雅关闭）。
 * - 同时只有一个 _processQueue 在执行；并发请求会被 reschedule。
 */

import { getMemoryConfig } from './config';
import { MemoryUpdater } from './updater';

export interface ConversationContext {
  threadId: string;
  messages: any[];
  timestamp: Date;
  agentName: string | null;
  userId: string | null;
  correctionDetected: boolean;
  reinforcementDetected: boolean;
}

export interface AddArgs {
  threadId: string;
  messages: any[];
  agentName?: string | null;
  userId?: string | null;
  correctionDetected?: boolean;
  reinforcementDetected?: boolean;
}

export class MemoryUpdateQueue {
  private queue: ConversationContext[] = [];
  private timer: NodeJS.Timeout | null = null;
  private processing = false;

  add(args: AddArgs): void {
    const cfg = getMemoryConfig();
    if (!cfg.enabled) return;

    this.enqueue(args);
    this.resetTimer();
    console.log(
      `[memory/queue] update queued for thread ${args.threadId}, queue size: ${this.queue.length}`,
    );
  }

  addNowait(args: AddArgs): void {
    const cfg = getMemoryConfig();
    if (!cfg.enabled) return;

    this.enqueue(args);
    this.scheduleTimer(0);
    console.log(
      `[memory/queue] update queued for immediate processing on thread ${args.threadId}, queue size: ${this.queue.length}`,
    );
  }

  private enqueue(args: AddArgs): void {
    const existing = this.queue.find((c) => c.threadId === args.threadId);
    const mergedCorrection =
      Boolean(args.correctionDetected) || Boolean(existing?.correctionDetected);
    const mergedReinforcement =
      Boolean(args.reinforcementDetected) || Boolean(existing?.reinforcementDetected);

    const ctx: ConversationContext = {
      threadId: args.threadId,
      messages: args.messages,
      timestamp: new Date(),
      agentName: args.agentName ?? null,
      userId: args.userId ?? null,
      correctionDetected: mergedCorrection,
      reinforcementDetected: mergedReinforcement,
    };

    this.queue = this.queue.filter((c) => c.threadId !== args.threadId);
    this.queue.push(ctx);
  }

  private resetTimer(): void {
    const cfg = getMemoryConfig();
    this.scheduleTimer(cfg.debounceSeconds * 1000);
  }

  private scheduleTimer(delayMs: number): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.processQueue();
    }, delayMs);
    // 不阻止进程退出（等价 daemon=True）
    this.timer.unref?.();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      // 已有 worker 在跑，重新调度
      this.scheduleTimer(0);
      return;
    }
    if (this.queue.length === 0) return;

    this.processing = true;
    const contexts = this.queue.slice();
    this.queue = [];
    this.timer = null;

    console.log(`[memory/queue] processing ${contexts.length} queued memory updates`);

    try {
      const updater = new MemoryUpdater();
      for (let i = 0; i < contexts.length; i++) {
        const ctx = contexts[i];
        try {
          console.log(`[memory/queue] updating memory for thread ${ctx.threadId}`);
          const ok = await updater.updateMemory(ctx.messages, {
            threadId: ctx.threadId,
            agentName: ctx.agentName,
            userId: ctx.userId,
            correctionDetected: ctx.correctionDetected,
            reinforcementDetected: ctx.reinforcementDetected,
          });
          if (ok) {
            console.log(`[memory/queue] memory updated for thread ${ctx.threadId}`);
          } else {
            console.warn(`[memory/queue] memory update skipped/failed for thread ${ctx.threadId}`);
          }
        } catch (e) {
          console.error(`[memory/queue] error updating memory for thread ${ctx.threadId}:`, e);
        }

        // 避免 LLM 限流
        if (contexts.length > 1 && i < contexts.length - 1) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /** 取消计时器并立即同步处理（优雅关闭 / 测试）。 */
  async flush(): Promise<void> {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.processQueue();
  }

  flushNowait(): void {
    this.scheduleTimer(0);
  }

  clear(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
    this.processing = false;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get isProcessing(): boolean {
    return this.processing;
  }
}

let _queue: MemoryUpdateQueue | null = null;

export function getMemoryQueue(): MemoryUpdateQueue {
  if (!_queue) _queue = new MemoryUpdateQueue();
  return _queue;
}

export function resetMemoryQueue(): void {
  if (_queue) _queue.clear();
  _queue = null;
}
