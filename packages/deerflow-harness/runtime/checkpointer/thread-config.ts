/**
 * buildThreadConfig —— 构造 LangGraph 调用所需的 RunnableConfig。
 *
 * checkpointer 据此路由到具体 thread 的 checkpoint。
 */

export interface ThreadConfig {
  configurable: {
    thread_id: string;
    checkpoint_ns: string;
    checkpoint_id?: string;
  };
}

export function buildThreadConfig(thread_id: string, checkpoint_id?: string): ThreadConfig {
  return {
    configurable: {
      thread_id,
      checkpoint_ns: '',
      ...(checkpoint_id ? { checkpoint_id } : {}),
    },
  };
}
