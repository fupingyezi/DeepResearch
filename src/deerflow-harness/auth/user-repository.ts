/**
 * users 表的数据访问层（pg）。
 *
 * 负责 UserRecord 与数据库行的映射，以及增删改查。
 * 邮箱唯一约束由 DB 层保证；create 捕获唯一冲突并抛 EMAIL_EXISTS 语义错误供上层转译。
 */

import { v4 as uuidv4 } from 'uuid';

import { query } from '@/lib';
import type { SystemRole, UserRecord } from './types';

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  system_role: SystemRole;
  needs_setup: boolean;
  token_version: number;
  created_at: string | Date;
  updated_at: string | Date;
}

function rowToUser(row: UserRow): UserRecord {
  return {
    id: String(row.id),
    email: row.email,
    passwordHash: row.password_hash,
    systemRole: row.system_role,
    needsSetup: row.needs_setup,
    tokenVersion: Number(row.token_version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function getUserByEmail(email: string): Promise<UserRecord | null> {
  const res = await query(`select * from users where email = $1 limit 1;`, [email]);
  const row = res.rows[0] as UserRow | undefined;
  return row ? rowToUser(row) : null;
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  const res = await query(`select * from users where id = $1 limit 1;`, [id]);
  const row = res.rows[0] as UserRow | undefined;
  return row ? rowToUser(row) : null;
}

export async function countAdminUsers(): Promise<number> {
  const res = await query(`select count(*)::int as count from users where system_role = 'admin';`);
  const row = res.rows[0] as { count: number } | undefined;
  return row ? Number(row.count) : 0;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string | null;
  systemRole: SystemRole;
  needsSetup?: boolean;
}

/** 唯一冲突（邮箱已存在）时抛出，code='EMAIL_EXISTS' */
export class EmailExistsError extends Error {
  code = 'EMAIL_EXISTS';
  constructor() {
    super('Email already exists');
  }
}

export async function createUser(input: CreateUserInput): Promise<UserRecord> {
  const id = uuidv4();
  try {
    const res = await query(
      `insert into users (id, email, password_hash, system_role, needs_setup)
       values ($1, $2, $3, $4, $5)
       returning *;`,
      [id, input.email, input.passwordHash, input.systemRole, input.needsSetup ?? false],
    );
    return rowToUser(res.rows[0] as UserRow);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '23505') throw new EmailExistsError();
    throw e;
  }
}

export interface UpdateUserInput {
  email?: string;
  passwordHash?: string | null;
  needsSetup?: boolean;
  tokenVersion?: number;
}

export async function updateUser(id: string, patch: UpdateUserInput): Promise<UserRecord> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (patch.email !== undefined) {
    sets.push(`email = $${i++}`);
    params.push(patch.email);
  }
  if (patch.passwordHash !== undefined) {
    sets.push(`password_hash = $${i++}`);
    params.push(patch.passwordHash);
  }
  if (patch.needsSetup !== undefined) {
    sets.push(`needs_setup = $${i++}`);
    params.push(patch.needsSetup);
  }
  if (patch.tokenVersion !== undefined) {
    sets.push(`token_version = $${i++}`);
    params.push(patch.tokenVersion);
  }
  sets.push(`updated_at = now()`);
  params.push(id);

  try {
    const res = await query(
      `update users set ${sets.join(', ')} where id = $${i} returning *;`,
      params,
    );
    return rowToUser(res.rows[0] as UserRow);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '23505') throw new EmailExistsError();
    throw e;
  }
}

/**
 * 把存量无归属的会话/消息回填给指定用户（首个 admin 创建时调用）。
 * 仅更新 user_id 为 NULL 的行，幂等。
 */
export async function backfillOrphanData(userId: string): Promise<void> {
  await query(`update chat_session set user_id = $1 where user_id is null;`, [userId]);
  await query(`update chat_message set user_id = $1 where user_id is null;`, [userId]);
  await query(`update threads_meta set user_id = $1 where user_id is null;`, [userId]);
  await query(`update runs set user_id = $1 where user_id is null;`, [userId]);
}
