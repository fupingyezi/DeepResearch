/**
 * 日期 / 时间通用工具。
 */

/**
 * 把 Date / string / number / undefined 归一化为 ISO-8601 字符串。
 *
 * - number       → 视作毫秒时间戳，转 ISO
 * - string       → 非空原样返回（假定已是 ISO 或可被 Date 接受）
 * - Date         → toISOString
 * - undefined    → 当前时间 ISO
 */
export function toIso(value: Date | string | number | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string' && value.length > 0) return value;
  return new Date().toISOString();
}

/**
 * 把 Date / string / number 格式化为 `YYYY-M-D`（不补零，与历史 sider 显示一致）。
 */
export function formatYmd(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
