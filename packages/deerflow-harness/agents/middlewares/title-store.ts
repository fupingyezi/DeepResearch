/**
 * TitleStoreProvider —— 标题中间件的持久化注入面。
 *
 * title-middleware 生成会话标题后需要读写 app 侧的 chat_session.title 与
 * threads_meta.display_name 两表；harness 不反向依赖宿主 DB，由宿主（wiring /
 * harness-adapters）注入实现。未注入时标题生成整体跳过（warn 一次）。
 */

export interface TitleStoreProvider {
  /** 读取当前标题状态；线程不存在返回 null。 */
  loadCurrentTitle(
    threadId: string,
  ): Promise<{ title: string | null; display_name: string | null } | null>;
  /** 把生成后的标题写入两表（实现方自持错误隔离语义）。 */
  persistTitle(threadId: string, title: string): Promise<void>;
}

// dev 下注册表挂 globalThis：Next 按路由分包编译，每个 route bundle 有独立的
// 模块图，纯模块级变量会分裂成多份——wiring 注册的 provider 只对首个执行
// build 的 bundle 可见，其余 bundle 里标题生成会静默失效。做法对齐
// memory/storage.ts 的 setMemoryStorage；vitest 默认按文件分进程，globalThis
// 与模块级变量的隔离语义一致，测试不受影响。
let _provider: TitleStoreProvider | null = null;

const globalForTitleStore =
  process.env.NODE_ENV === 'production'
    ? null
    : (globalThis as unknown as { __titleStoreProvider?: TitleStoreProvider | null });

export function setTitleStoreProvider(provider: TitleStoreProvider | null): void {
  if (globalForTitleStore) globalForTitleStore.__titleStoreProvider = provider;
  else _provider = provider;
}

export function getTitleStoreProvider(): TitleStoreProvider | null {
  return globalForTitleStore?.__titleStoreProvider ?? _provider;
}
