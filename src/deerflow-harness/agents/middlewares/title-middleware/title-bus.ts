/**
 * title-bus
 *
 * TitleMiddleware 与 SSE 输出层（route.ts wrapWithPersistence）之间的
 * 单向桥接：middleware 在 `afterAgent` 异步生成并落库标题后，把更新结果
 * 推入本 bus；输出层在 yield END 事件之前 `consume`，把结果挂到 END
 * payload 的 `titleUpdate` 字段，前端据此即时刷新 sider 列表标题。
 *
 * 时序保证：
 * - LangGraph 在所有 middleware 的 `afterAgent` 执行完毕后才发出
 *   LIFECYCLE{stage:'done'}（→ END）。因此 publish 一定先于 consume。
 *
 */

export interface TitleUpdatePayload {
  sessionId: string;
  title: string;
  updatedAt: number;
}

/** 5 分钟兜底 TTL：远超正常 stream 周期，仅用于异常路径。 */
const PENDING_TTL_MS = 5 * 60_000;

interface PendingEntry extends TitleUpdatePayload {
  enqueuedAt: number;
}

const pending = new Map<string, PendingEntry>();

/**
 * 发布一条标题更新（由 TitleMiddleware 在落库成功后调用）。
 * 同 threadId 后到的覆盖先到的（理论上一轮内只会触发一次）。
 */
export function publishTitleUpdate(threadId: string, payload: TitleUpdatePayload): void {
  if (!threadId) return;
  pending.set(threadId, { ...payload, enqueuedAt: Date.now() });
  // 顺手清理过期项（本轮就近清理，避免独立 timer）。
  sweepExpired();
}

/**
 * 取出一条标题更新（由 SSE 输出层在 yield END 之前调用）。
 * 取出后立即从 bus 删除；无更新时返回 null。
 */
export function consumeTitleUpdate(threadId: string): TitleUpdatePayload | null {
  if (!threadId) return null;
  const entry = pending.get(threadId);
  if (!entry) return null;
  pending.delete(threadId);
  return {
    sessionId: entry.sessionId,
    title: entry.title,
    updatedAt: entry.updatedAt,
  };
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [tid, entry] of pending) {
    if (now - entry.enqueuedAt > PENDING_TTL_MS) {
      pending.delete(tid);
    }
  }
}

/** 测试用：清空 bus。 */
export function _resetTitleBus(): void {
  pending.clear();
}
