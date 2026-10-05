/**
 * 一次性迁移脚本：旧文件后端（memory.json）→ PG 双表。
 *
 * 用途：记忆全量迁 PG 后，运行时代码不再读 memory.json；本脚本把存量文件按
 * 旧路径策略逐 scope 导入 PG，**scope 行已存在则跳过**（PG 增量优先，与旧
 * 懒迁移的 ON CONFLICT DO NOTHING 语义一致）。只读不删：旧文件原样保留，
 * 回滚 = 换回旧镜像。
 *
 * 路径策略（与旧 paths.ts 一致，base = DEERFLOW_DATA_DIR 或 ~/.deer-flow）：
 *   {base}/memory.json                          → 全局 scope        `::`
 *   {base}/agents/{name}/memory.json            → per-agent         `::{name}`
 *   {base}/users/{userId}/memory.json           → per-user          `{userId}::`
 *   {base}/users/{userId}/agents/{name}/...     → per-user-agent    `{userId}::{name}`
 *
 * 用法：
 *   node scripts/migrate-memory-to-pg.mjs [--base <dir>] [--dry-run]
 *   环境变量：DATABASE_URL（必填）；--base 覆盖 DEERFLOW_DATA_DIR。
 *
 * 前置条件：应用已用新版本启动过一次（initialMemoryDb 建好两表）；向量列
 * 维度从 pg_attribute 探测，与运行时口径一致。维度不符的存量向量不入库，
 * 由运行时 backfillMemoryEmbeddings 重嵌。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const baseFlag = args.indexOf('--base');
const base =
  (baseFlag >= 0 && args[baseFlag + 1]) ||
  process.env.DEERFLOW_DATA_DIR ||
  path.join(os.homedir(), '.deer-flow');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[migrate-memory] DATABASE_URL 未设置');
  process.exit(1);
}

const RECALL_SECTION_SLOTS = [
  ['user', 'topOfMind'],
  ['history', 'recentMonths'],
  ['history', 'earlierContext'],
  ['history', 'longTermBackground'],
];

function isFiniteVector(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/** 与运行时 toUnitVector 同口径：|normSq−1|≤1e-5 视为已归一；零向量跳过。 */
function toUnitVector(v) {
  const normSq = v.reduce((acc, x) => acc + x * x, 0);
  if (normSq < 1e-12) return null;
  if (Math.abs(normSq - 1) <= 1e-5) return v;
  const scale = Math.sqrt(normSq);
  return v.map((x) => x / scale);
}

/** 收集可入库向量行：kind/refId 口径与 PgMemoryStorage.collectVectorRows 一致。 */
function collectVectorRows(data, dims) {
  const rows = [];
  for (const f of data.facts ?? []) {
    if (isFiniteVector(f.embedding) && f.embedding.length === dims) {
      const v = toUnitVector(f.embedding);
      if (v) rows.push({ kind: 'fact', refId: String(f.id), vector: v });
    }
  }
  for (const [group, slot] of RECALL_SECTION_SLOTS) {
    const s = data[group]?.[slot];
    if (s?.summary && isFiniteVector(s.embedding) && s.embedding.length === dims) {
      const v = toUnitVector(s.embedding);
      if (v) rows.push({ kind: 'section', refId: `${group}.${slot}`, vector: v });
    }
  }
  return rows;
}

/** jsonb 不含 embedding（与运行时 stripEmbeddings 同口径，向量只进 memory_vectors）。 */
function stripEmbeddings(data) {
  return {
    ...data,
    user: Object.fromEntries(
      Object.entries(data.user ?? {}).map(([k, s]) => [
        k,
        s && typeof s === 'object'
          ? Object.fromEntries(Object.entries(s).filter(([key]) => key !== 'embedding'))
          : s,
      ]),
    ),
    history: Object.fromEntries(
      Object.entries(data.history ?? {}).map(([k, s]) => [
        k,
        s && typeof s === 'object'
          ? Object.fromEntries(Object.entries(s).filter(([key]) => key !== 'embedding'))
          : s,
      ]),
    ),
    facts: (data.facts ?? []).map((f) =>
      f && typeof f === 'object'
        ? Object.fromEntries(Object.entries(f).filter(([key]) => key !== 'embedding'))
        : f,
    ),
  };
}

// 发现全部旧文件：{base}/memory.json、agents/<name>、users/<uid>、users/<uid>/agents/<name>
async function discoverFiles() {
  const found = [];
  const push = (file, userId, agentName) =>
    found.push({
      file,
      scopeKey: `${userId ?? ''}::${agentName ?? ''}`,
      userId: userId ?? null,
      agentName: agentName ?? null,
    });

  push(path.join(base, 'memory.json'), null, null);

  const listDirs = async (dir) => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };

  for (const name of await listDirs(path.join(base, 'agents'))) {
    push(path.join(base, 'agents', name, 'memory.json'), null, name);
  }
  for (const userId of await listDirs(path.join(base, 'users'))) {
    push(path.join(base, 'users', userId, 'memory.json'), userId, null);
    for (const name of await listDirs(path.join(base, 'users', userId, 'agents'))) {
      push(path.join(base, 'users', userId, 'agents', name, 'memory.json'), userId, name);
    }
  }
  return found;
}

async function readMemory(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    return null; // 文件不存在（discover 与读取之间的竞态）或不可读：跳过
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // 坏 JSON：与旧懒迁移同口径，落一条空 schema 行
  }
}

async function migrate() {
  const files = await discoverFiles();
  if (files.length === 0) {
    console.log(`[migrate-memory] ${base} 下未发现 legacy 文件，无需迁移`);
    return;
  }
  console.log(`[migrate-memory] base=${base} files=${files.length}${dryRun ? ' [dry-run]' : ''}`);

  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

  // 探测向量列维度：表不存在说明应用还没用新版本启动过，直接报错
  let dims;
  try {
    const r = await pool.query(
      `SELECT atttypmod AS dims FROM pg_attribute
       WHERE attrelid = 'memory_vectors'::regclass AND attname = 'embedding'`,
    );
    dims = Number(r.rows[0]?.dims);
  } catch {
    console.error(
      '[migrate-memory] 未找到 memory_vectors 表：请先用新版本启动应用一次（initialMemoryDb 建表），再跑本脚本',
    );
    await pool.end();
    process.exit(1);
  }
  console.log(`[migrate-memory] 向量列维度=${dims}`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const { file, scopeKey, userId, agentName } of files) {
    const data = await readMemory(file);
    if (data === null) continue;

    const exists = await pool.query('SELECT 1 FROM memory_state WHERE scope_key = $1', [scopeKey]);
    if (exists.rows.length > 0) {
      console.log(`skip   ${scopeKey || '(全局)'}  行已存在`);
      skipped++;
      continue;
    }

    const vectors = collectVectorRows(data, dims);
    if (dryRun) {
      console.log(
        `would  ${scopeKey || '(全局)'}  facts=${(data.facts ?? []).length} vectors=${vectors.length}`,
      );
      migrated++;
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // ON CONFLICT DO NOTHING + RETURNING：并发下若有写入竞态，插不进去就整体跳过
      const ins = await client.query(
        `INSERT INTO memory_state (scope_key, user_id, agent_name, data, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, now())
         ON CONFLICT (scope_key) DO NOTHING RETURNING scope_key`,
        [scopeKey, userId, agentName, JSON.stringify(stripEmbeddings(data))],
      );
      if (ins.rows.length === 0) {
        await client.query('ROLLBACK');
        console.log(`skip   ${scopeKey || '(全局)'}  行已存在（并发写入）`);
        skipped++;
        continue;
      }
      if (vectors.length > 0) {
        const params = [];
        const values = [];
        for (const row of vectors) {
          const b = params.length;
          values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::vector)`);
          params.push(scopeKey, row.kind, row.refId, JSON.stringify(row.vector));
        }
        await client.query(
          `INSERT INTO memory_vectors (scope_key, kind, ref_id, embedding)
           VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`,
          params,
        );
      }
      await client.query('COMMIT');
      console.log(
        `migrate ${scopeKey || '(全局)'}  facts=${(data.facts ?? []).length} vectors=${vectors.length}`,
      );
      migrated++;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`error  ${scopeKey || '(全局)'}  ${e instanceof Error ? e.message : e}`);
      errors++;
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log(`[migrate-memory] 完成：migrated=${migrated} skipped=${skipped} errors=${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

migrate().catch((e) => {
  console.error('[migrate-memory] 失败:', e);
  process.exit(1);
});
