/**
 * 全局 401 事件：任意 API 请求收到 401（会话被吊销/过期）时广播，
 * AuthProvider 监听后清登录态并跳 /login。
 *
 * 用 window CustomEvent 而非 React context：ApiClient / SSE 生成器都在组件树外
 * 的纯模块里，走 DOM 事件零依赖解耦。
 * auth 族请求（登录/注册/登出）走 utils/auth/client.ts 的裸 fetch，不经
 * ApiClient，登录失败的 401 不会误触发全局登出。
 */

export const AUTH_401_EVENT = 'auth:unauthorized';

export function dispatchUnauthorized(): void {
  window.dispatchEvent(new CustomEvent(AUTH_401_EVENT));
}

export function onUnauthorized(handler: () => void): () => void {
  window.addEventListener(AUTH_401_EVENT, handler);
  return () => window.removeEventListener(AUTH_401_EVENT, handler);
}
