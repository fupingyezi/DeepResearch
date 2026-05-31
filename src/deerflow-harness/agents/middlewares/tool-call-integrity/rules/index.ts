import type { IntegrityRule } from '../types';
import { unknownToolCallRule } from './unknown-tool-call';
import { danglingToolCallRule } from './dangling-tool-call';

/**
 * 默认规则集合（顺序敏感）。
 *
 * 顺序约束：
 *  1) UnknownToolCallRule —— 先剔除指向未知工具的 tool_call 并补占位
 *  2) DanglingToolCallRule —— 再为剩余真正悬挂的 tool_call 补占位
 *
 * 为什么 Unknown 先于 Dangling？
 *   若反过来，Dangling 会先为"未知工具的 tool_call_id"补一条占位 ToolMessage，
 *   然后 Unknown 再剔除该 tool_call、把刚补的占位当作孤立 ToolMessage 丢弃 ——
 *   产生一次无效写入。当前顺序两条规则职责不重叠、各自只做一次工作。
 *
 * 新增规则只需在此处追加导出，外部使用方不感知。
 */
export const DEFAULT_INTEGRITY_RULES: readonly IntegrityRule[] = [
  unknownToolCallRule,
  danglingToolCallRule,
];

export { unknownToolCallRule, danglingToolCallRule };
