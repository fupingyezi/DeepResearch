/**
 * 前端 API 基址运行时注入：根 layout 服务端把 env API_BASE_URL 输出为
 * window.__API_BASE__（空 = 同源），客户端所有 API/SSE 请求经 getApiBase()
 * 拼接。单镜像多环境：同一构建产物用不同 env 即可指向不同 API 域。
 */

declare global {
  interface Window {
    __API_BASE__?: string;
  }
}

export function getApiBase(): string {
  // SSR 求值模块时 window 不存在，回落同源（真实请求只发生在浏览器侧）
  return typeof window !== 'undefined' ? (window.__API_BASE__ ?? '') : '';
}
