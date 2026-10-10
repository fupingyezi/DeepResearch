/**
 * JWT 签发与解析（jsonwebtoken，HS256）——无状态双 token。
 *
 * access：{ sub, ver, typ:'access' }，短有效期（分钟级）；refresh：{ sub, ver, jti,
 * typ:'refresh' }，长有效期（天级）。两者都不携带服务端状态，鉴权只验签名 +
 * 比对 users.token_version（改密/重置自增后旧 token 全部失效）。
 *
 * typ 是 payload 内自定义声明：双 token 验签必须各归其位（access 塞进 refresh
 * cookie 或反之都会被拒），旧版无 typ 的存量 token 同样被拒——部署即强制重登
 * 一次，换来得是会话撤销不依赖任何 DB 状态。
 *
 * 密钥取自 AUTH_JWT_SECRET；access 时长取 AUTH_ACCESS_TOKEN_EXPIRES_MINUTES
 * （默认 15 分钟），refresh 时长取 AUTH_TOKEN_EXPIRY_DAYS（默认 7 天）。
 * 在 Node runtime 的 API 路由内验签（不在 Edge 中间件做）。
 */

import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

export type TokenType = 'access' | 'refresh';

export interface AccessTokenPayload {
  sub: string;
  ver: number;
  typ: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  ver: number;
  typ: 'refresh';
  /** 每次轮换新生成的唯一 id：为将来引入重用检测预留锚点，现在只保证唯一性 */
  jti: string;
}

/** 成对轮换的 token 对（透明刷新时双 token 一起重签） */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

function getSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) {
    throw new Error('AUTH_JWT_SECRET is not set');
  }
  return secret;
}

export function getAccessTokenExpiryMinutes(): number {
  const raw = Number(process.env.AUTH_ACCESS_TOKEN_EXPIRES_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 15;
}

/** refresh token 有效期（天）：语义为「不活跃多少天后需重新登录」，每次刷新滑动续期 */
export function getTokenExpiryDays(): number {
  const raw = Number(process.env.AUTH_TOKEN_EXPIRY_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 7;
}

/** jsonwebtoken 的 expiresIn 要求模板字面量类型（`${number}m` 等），普通 string 过不了类型检查 */
type JwtExpiresIn = `${number}m` | `${number}d`;

function sign(payload: Record<string, unknown>, expiresIn: JwtExpiresIn): string {
  return jwt.sign(payload, getSecret(), { algorithm: 'HS256', expiresIn });
}

export function createAccessToken(userId: string, tokenVersion: number): string {
  return sign(
    { sub: userId, ver: tokenVersion, typ: 'access' },
    `${getAccessTokenExpiryMinutes()}m`,
  );
}

export function createRefreshToken(userId: string, tokenVersion: number): string {
  return sign(
    { sub: userId, ver: tokenVersion, typ: 'refresh', jti: randomUUID() },
    `${getTokenExpiryDays()}d`,
  );
}

/**
 * 验签并校验声明的公共路径：typ 必须匹配、sub/ver 必填且类型正确、
 * refresh 额外要求 jti。任何失败（过期/签名错/格式错/声明不符）统一返回 null。
 */
function verifyWithType<T extends AccessTokenPayload | RefreshTokenPayload>(
  token: string,
  typ: TokenType,
): T | null {
  try {
    const decoded = jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
    if (typeof decoded === 'string') return null;
    const claims = decoded as Record<string, unknown>;
    if (claims.typ !== typ) return null;
    if (typeof claims.sub !== 'string' || typeof claims.ver !== 'number') return null;
    if (typ === 'refresh' && typeof claims.jti !== 'string') return null;
    return claims as unknown as T;
  } catch {
    return null;
  }
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  return verifyWithType<AccessTokenPayload>(token, 'access');
}

export function verifyRefreshToken(token: string): RefreshTokenPayload | null {
  return verifyWithType<RefreshTokenPayload>(token, 'refresh');
}
