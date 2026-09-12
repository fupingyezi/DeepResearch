import { isMemoryInjectionMode, type MemoryInjectionMode } from '@/types';

/**
 * 组装 `/api/v3/chat` 请求体的 `configuration` 段。
 *
 * 单独成模块（而非内联在 stream-chat-handler 内）的两个理由：
 * 1. handler 的 import 链会拉到 React 组件，node 环境的单测无法 transform JSX；
 * 2. 这里是**用户可见开关的落点** —— 参数被静默丢弃时（历史上发生过多次：
 *    metadata 展开、字段名拼写、只接受字面量）功能会悄无声息地失效，
 *    需要能被单测直接钉住。
 *
 * 约定：只带上确实有值的字段；缺省不传该键，由后端按服务级默认处理
 * （`model` 缺省走用户落库的偏好，`memoryMode` 缺省走 inject）。
 */
export function buildChatConfiguration(input: {
  model?: string;
  memoryMode?: MemoryInjectionMode;
}): Record<string, unknown> {
  const configuration: Record<string, unknown> = {};

  if (typeof input.model === 'string' && input.model.length > 0) {
    configuration.model = { value: input.model };
  }
  // 严格字面量判定：拼写错误（如 'retrive'）不静默回落，直接不带该字段
  if (isMemoryInjectionMode(input.memoryMode)) {
    configuration.memoryMode = input.memoryMode;
  }

  return configuration;
}
