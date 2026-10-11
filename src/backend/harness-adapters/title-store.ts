import { query } from '@/backend/lib/db';

import type { TitleStoreProvider } from '@deerflow-harness/agents/middlewares/title-store';

/**
 * TitleStoreProvider 的 app 实现：harness 的 title-middleware 不再直连 SQL，
 * 经此适配器读写 chat_session / threads_meta 两表的标题。SQL 与文案自
 * title-middleware 逐字搬移，保证行为一致（错误隔离语义一并保留）。
 */

async function loadCurrentTitle(
  threadId: string,
): Promise<{ title: string | null; display_name: string | null } | null> {
  // chat_session 与 threads_meta 都按 id = threadId 主键查询；left join 以兼容
  // 仅在其中一边存在的 race（理论上 v3/chat 路由两边都会创建）。
  const res = await query(
    `select cs.title as title, tm.display_name as display_name
       from threads_meta tm
       left join chat_session cs on cs.id = tm.thread_id
      where tm.thread_id = $1
      limit 1;`,
    [threadId],
  );
  const row = res.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    title: row.title == null ? null : String(row.title),
    display_name: row.display_name == null ? null : String(row.display_name),
  };
}

async function persistTitle(threadId: string, title: string): Promise<void> {
  // 两条独立 query，任一失败仅 console.error，不阻塞另一条。
  // chat_session 是前端 sider 列表数据源；threads_meta 是 deerflow-harness 的
  // 元信息表，未来 deer-flow 风格 worker 收尾或 ownership 校验也会用到。
  try {
    await query(`update chat_session set title = $1, updated_at = now() where id = $2;`, [
      title,
      threadId,
    ]);
  } catch (e) {
    console.error('[titleMiddleware] update chat_session.title failed:', e);
  }
  try {
    await query(
      `update threads_meta set display_name = $1, updated_at = now() where thread_id = $2;`,
      [title, threadId],
    );
  } catch (e) {
    console.error('[titleMiddleware] update threads_meta.display_name failed:', e);
  }
}

export const titleStoreProvider: TitleStoreProvider = {
  loadCurrentTitle,
  persistTitle,
};
