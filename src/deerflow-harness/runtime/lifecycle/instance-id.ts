import os from 'node:os';

/**
 * 本进程的 owner 标识（DEERFLOW_INSTANCE_ID ?? hostname:pid）：run 登记与取消
 * 请求都以它路由（取消消息送达登记该 run 的进程）。
 */
export function getInstanceOwner(): string {
  return process.env.DEERFLOW_INSTANCE_ID || `${os.hostname()}:${process.pid}`;
}
