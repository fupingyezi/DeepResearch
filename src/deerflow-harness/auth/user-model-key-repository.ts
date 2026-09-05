/**
 * user_model_keys 表 + users.selected_model 的数据访问层（pg）。
 *
 * 职责：
 * - 保存 / 删除用户某 provider 的加密 API Key（密文 + IV + authTag + 掩码）。
 * - 列出本人已配置的 provider 及掩码（绝不返回明文）。
 * - 读取本人某 provider 的明文 Key（解密，仅供服务端注入模型时调用）。
 * - 读取 / 设置用户当前选用的模型预设（selected_model）。
 *
 * 安全约束：
 * - 所有查询参数化（防 SQLi），且所有方法都以 userId 为第一筛选条件（按本人隔离）。
 * - 明文 Key 仅在 getDecryptedKey 内部短暂出现，调用方用后即弃，不得落库 / 打日志。
 */

import { query } from '@/lib';
import {
  decryptKey,
  encryptKey,
  maskKey,
  type EncryptedPayload,
} from '@/lib/crypto/model-key-crypto';

/** 已配置 provider 的对外安全视图（不含明文 / 密文）。 */
export interface ConfiguredProvider {
  provider: string;
  masked: string;
}

interface UserModelKeyRow {
  provider: string;
  enc_key: string;
  iv: string;
  auth_tag: string;
  key_masked: string;
}

/**
 * 保存（upsert）某 provider 的 API Key。
 * 已存在则覆盖更新密文 / IV / authTag / 掩码并刷新 updated_at。
 */
export async function upsertModelKey(
  userId: string,
  provider: string,
  apiKeyPlain: string,
): Promise<ConfiguredProvider> {
  const payload: EncryptedPayload = encryptKey(apiKeyPlain);
  const masked = maskKey(apiKeyPlain);
  await query(
    `insert into user_model_keys (user_id, provider, enc_key, iv, auth_tag, key_masked)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (user_id, provider)
     do update set enc_key = excluded.enc_key,
                   iv = excluded.iv,
                   auth_tag = excluded.auth_tag,
                   key_masked = excluded.key_masked,
                   updated_at = now();`,
    [userId, provider, payload.ciphertext, payload.iv, payload.authTag, masked],
  );
  return { provider, masked };
}

/** 删除本人某 provider 的 Key。 */
export async function deleteModelKey(userId: string, provider: string): Promise<void> {
  await query(`delete from user_model_keys where user_id = $1 and provider = $2;`, [
    userId,
    provider,
  ]);
}

/** 列出本人已配置的 provider + 掩码（绝不含明文）。 */
export async function listConfiguredProviders(userId: string): Promise<ConfiguredProvider[]> {
  const res = await query(
    `select provider, key_masked from user_model_keys where user_id = $1 order by provider;`,
    [userId],
  );
  return (res.rows as Array<{ provider: string; key_masked: string }>).map((row) => ({
    provider: row.provider,
    masked: row.key_masked,
  }));
}

/**
 * 读取本人某 provider 的明文 Key（解密）。
 * 未配置返回 null；解密失败（密文被篡改 / 密钥变更）同样返回 null，由调用方降级处理。
 */
export async function getDecryptedKey(userId: string, provider: string): Promise<string | null> {
  const res = await query(
    `select provider, enc_key, iv, auth_tag, key_masked
       from user_model_keys where user_id = $1 and provider = $2 limit 1;`,
    [userId, provider],
  );
  const row = res.rows[0] as UserModelKeyRow | undefined;
  if (!row) return null;
  try {
    return decryptKey({ ciphertext: row.enc_key, iv: row.iv, authTag: row.auth_tag });
  } catch {
    console.error('[user-model-key-repository] decrypt failed for provider:', provider);
    return null;
  }
}

/** 读取用户当前选用的模型预设 key；未设置返回 null。 */
export async function getSelectedModel(userId: string): Promise<string | null> {
  const res = await query(`select selected_model from users where id = $1 limit 1;`, [userId]);
  const row = res.rows[0] as { selected_model: string | null } | undefined;
  return row?.selected_model ?? null;
}

/** 设置用户当前选用的模型预设 key。 */
export async function setSelectedModel(userId: string, modelKey: string): Promise<void> {
  await query(`update users set selected_model = $1, updated_at = now() where id = $2;`, [
    modelKey,
    userId,
  ]);
}
