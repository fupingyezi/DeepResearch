/**
 * 宿主注入的最小 SQL 执行面（单查询 + 事务）。
 *
 * 由宿主（app 层）包装自己的连接池注入（实现 SQL 存储适配时传入）。
 * harness 不反向依赖宿主，也不依赖 pg 驱动的具体类型。
 */
export interface SqlExecutor {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  /** BEGIN/COMMIT/ROLLBACK 语义；fn 抛错时自动回滚并原样上抛。不支持嵌套。 */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
