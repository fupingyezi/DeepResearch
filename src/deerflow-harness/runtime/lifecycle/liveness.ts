/**
 * run 存活协议的定时参数：生产侧（executeRun 心跳）与消费侧（重连守卫判死、
 * owner 登记键续租、僵尸回收判死）共享同一组推导，改心跳间隔时两侧同步变化。
 *
 * - HEARTBEAT_INTERVAL_MS：执行体存活心跳间隔。模型长输出 / 长工具调用期间
 *   可能几十秒无业务事件，心跳保证事件流在窗口内持续产出
 * - OWNER_DEAD_AFTER_MS：owner 死亡判定阈值 = 3 个心跳窗口，容忍单次心跳抖动。
 *   重连守卫用它判「事件静默 = owner 已死」，owner 登记键的存活 TTL 与它一致
 *   （键到期 = 判死），僵尸回收也按同一时间尺度识别死 owner
 */

/** 执行体存活心跳间隔（毫秒）。 */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** owner 死亡判定阈值（毫秒）：3 个心跳窗口。 */
export const OWNER_DEAD_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS;
