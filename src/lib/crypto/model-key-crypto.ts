/**
 * 模型 API Key 的对称加解密工具（AES-256-GCM）。
 *
 * 设计要点：
 * - 用户在「设置-模型管理」填写的各厂商 API Key 不得明文落库；本模块负责
 *   加密（落库前）与解密（服务端鉴权后注入模型）。
 * - 加密密钥来自环境变量 MODEL_KEY_ENC_SECRET；若未配置，则由 AUTH_JWT_SECRET
 *   经 scrypt 派生为 32 字节密钥兜底（保证存在性，但建议显式配置独立密钥）。
 * - AES-256-GCM 自带完整性校验（authTag），可防密文被篡改。
 * - 每次加密使用随机 12 字节 IV；密文 / IV / authTag 一并落库（base64）。
 *
 * 安全约束：
 * - 严禁将明文 Key / 密文 / IV / authTag 打印到日志。
 * - 解密只在服务端鉴权通过后进行，且仅作用于本人记录。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM 推荐 12 字节
const KEY_LENGTH = 32; // AES-256
// 固定 salt：仅用于把可变长度的 secret 稳定派生为 32 字节密钥，
// 不承担抗彩虹表职责（secret 本身即高熵随机串）。
const KEY_SALT = 'mini-deepresearch:model-key-enc:v1';

/** 加密结果：三段 base64，分别落库到 enc_key / iv / auth_tag 列。 */
export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

let cachedKey: Buffer | null = null;

/**
 * 解析 32 字节加密密钥：
 * 优先 MODEL_KEY_ENC_SECRET，缺省回退 AUTH_JWT_SECRET；
 * 两者均无则抛错（避免静默使用空密钥）。
 */
function getEncKey(): Buffer {
  if (cachedKey) return cachedKey;

  const secret = process.env.MODEL_KEY_ENC_SECRET || process.env.AUTH_JWT_SECRET;
  if (!secret) {
    throw new Error(
      'Neither MODEL_KEY_ENC_SECRET nor AUTH_JWT_SECRET is set; cannot encrypt model API keys.',
    );
  }
  // scrypt 把任意长度 secret 稳定派生为 32 字节密钥。
  cachedKey = scryptSync(secret, KEY_SALT, KEY_LENGTH);
  return cachedKey;
}

/** 加密明文 API Key。 */
export function encryptKey(plain: string): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getEncKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * 解密 API Key。密文被篡改 / 密钥不匹配时 GCM 校验失败抛错，
 * 调用方需捕获并按语义降级（不得泄漏底层错误细节）。
 */
export function decryptKey(payload: EncryptedPayload): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    getEncKey(),
    Buffer.from(payload.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

/**
 * 生成用于前端展示的掩码（绝不回显明文）。
 * 规则：保留前 3 位与后 4 位，中间用 *** 代替；过短则整体打码。
 * 例：sk-1234567890abcd → sk-***abcd
 */
export function maskKey(plain: string): string {
  const trimmed = plain.trim();
  if (trimmed.length <= 7) return '***';
  const head = trimmed.slice(0, 3);
  const tail = trimmed.slice(-4);
  return `${head}***${tail}`;
}
