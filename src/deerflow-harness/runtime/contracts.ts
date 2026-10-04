/**
 * ThreadService 依赖的进程间契约：run 登记表（RunRegistry）与事件总线（RunEventBus）。
 *
 * 两个硬约束决定了接口形状：
 * - AbortController 不可序列化 → 取消只能消息式投递：requestCancel 把取消请求送达
 *   owner 进程，由 owner 进程注册的 handler 真正 abort；
 * - 消息中间件无状态（发过的消息不留档）→ 事件回放必须由实现自带存储（进程内
 *   实现靠 ThreadChannel buffer），契约只承诺「晚订阅可拿历史」的语义。
 *
 * 本地与跨进程实现可互换（service 不感知），isDistributed() 供可观测性判断当前
 * 模式——降级必须可见，不能静默变成单进程语义。
 */

import type { ClientAgentEvent, StampedClientAgentEvent } from './sse/client-event';

export interface RunOwnerInfo {
  runId: string;
  threadId: string;
  /** 进程标识（DEERFLOW_INSTANCE_ID ?? hostname:pid）：取消请求按 owner 路由。 */
  owner: string;
  startedAt: number;
}

export interface RunRegistry {
  register(info: RunOwnerInfo): Promise<void>;
  unregister(runId: string): Promise<void>;
  ownerOf(runId: string): Promise<RunOwnerInfo | null>;
  listByThread(threadId: string): Promise<RunOwnerInfo[]>;
  /**
   * 请求取消一个 run（消息式，非本地 abort）：实现负责把请求送达 owner 进程。
   * 返回已投递的取消数（run 不存在 / 已收尾为 0），作为 cancelRun 的 cancelled
   * 返回语义。跨进程实现无法同步拿到远端 handler 回报，只能报投递数。
   */
  requestCancel(runId: string, reason: string): Promise<number>;
  /** 注册本进程的取消请求处理器：返回 1 = 命中并 abort，0 = run 不在本进程。 */
  onCancelRequest(handler: (runId: string, reason: string) => number): void;
  isDistributed(): boolean;
}

export interface RunEventBus {
  publish(threadId: string, runId: string, event: ClientAgentEvent): Promise<void>;
  /**
   * 订阅 run 事件流：晚订阅必须能拿到历史（进程内实现回放 ThreadChannel buffer）。
   * 每个事件带实现生成的单调游标 eventId；fromEventId 断点续读——只交付游标
   * 严格晚于 fromEventId 的事件（客户端重连带回最后收到的 eventId 即不丢不重）。
   */
  subscribe(
    threadId: string,
    runId: string,
    fromEventId?: string,
  ): AsyncIterable<StampedClientAgentEvent>;
  /** run 终态且订阅全部结束后释放资源（进程内实现 = StreamBridge.drop）。 */
  release(threadId: string, runId: string): Promise<void>;
  isDistributed(): boolean;
}
