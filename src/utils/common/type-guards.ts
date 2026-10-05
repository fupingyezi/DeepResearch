/**
 * 通用类型守卫与判空工具。
 *
 * 处于 SSE 流式 hot path：实现保持纯同步、零外部依赖。
 */

/**
 * args 是否「有意义」（非空）。
 *
 * 与前后端 collector / 前端 timeline 同口径，避免落库出现 ghost 子调用记录：
 * - undefined / null            → false
 * - '' / '   ' / '{}' / '[]'    → false（仅 string，trim 后判断；'[]' 兜底防 JSON 形态）
 * - [] / {}                     → false
 * - 其它（非空 string / 非空数组 / 非空对象 / number / boolean） → true
 */
export function hasMeaningfulArgs(args: unknown): boolean {
  if (args === undefined || args === null) return false;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (trimmed.length === 0) return false;
    if (trimmed === '{}' || trimmed === '[]') return false;
    return true;
  }
  if (Array.isArray(args)) return args.length > 0;
  if (typeof args === 'object') return Object.keys(args as Record<string, unknown>).length > 0;
  return true;
}
