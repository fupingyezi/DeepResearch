/**
 * 事件过滤配置接口
 *
 * 控制 streamEvents 的事件粒度，避免不必要的事件传输开销
 */
export interface EventFilterConfig {
  /** 仅包含带有这些 tag 的事件 */
  includeTags?: string[];
  /** 仅包含这些名称的事件 */
  includeNames?: string[];
  /** 排除这些名称的事件 */
  excludeNames?: string[];
  /** 仅包含这些事件类型（LangChain 原生事件类型） */
  includeTypes?: string[];
  /** 排除这些事件类型 */
  excludeTypes?: string[];
}
