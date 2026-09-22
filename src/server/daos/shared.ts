/**
 * app 层 DAO 共享设施。
 *
 * 事务规则：BEGIN/COMMIT/ROLLBACK 只出现在 withTransaction；store 方法全部带可选
 * `db?: SqlExecutor`——传了走事务连接，不传走 @/lib/db 的 query（单语句）。
 * DAO 自身不开事务。
 */

import { getClient } from '@/lib/db';

/**
 * 与 pg 的 PoolClient 结构匹配（只要求 query 签名），事务内各 store 方法经它共享
 * 同一条连接。
 */
export type SqlExecutor = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export async function withTransaction<T>(fn: (db: SqlExecutor) => Promise<T>): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[withTransaction] rollback failed:', rollbackErr);
    }
    throw e;
  } finally {
    client.release();
  }
}
