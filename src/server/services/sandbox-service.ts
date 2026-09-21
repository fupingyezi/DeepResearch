/**
 * 沙箱监控服务（薄壳）：只读的容器/并发运行态快照。
 *
 * 无编排逻辑，仅透传 harness 的 getSandboxSnapshot；存在意义是让 route 层
 * 不直接依赖 harness 的监控入口。token 门控留在路由层——那是 HTTP 访问控制，
 * 不属于服务语义。
 */

import { getSandboxSnapshot } from '@/deerflow-harness';

/** 沙箱运行态快照；仅 docker backend 有数据，local 返回空。 */
export function getSandboxStatsSnapshot(includeStats: boolean): Promise<unknown> {
  return getSandboxSnapshot(includeStats);
}
