/**
 * JSON 安全解析
 *
 * 处于 SSE 流式 hot path（每个 stream_chunk / tool_call / task_progress
 * 事件都会调用），实现保持纯同步、零分配 fast-path：非字符串直接返回，
 * 字符串才走 try/catch。
 */
export function parseJsonSafe(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
