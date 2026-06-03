/**
 * JWT 签发与解析（jsonwebtoken，HS256）。
 *
 * token payload：{ sub: userId, ver: tokenVersion, iat, exp }。
 * 密钥取自 AUTH_JWT_SECRET 环境变量；过期时长取 AUTH_TOKEN_EXPIRY_DAYS（默认 7 天）。
 * 在 Node runtime 的 API 路由内验签（不在 Edge 中间件做）。
 */

import jwt from 'jsonwebtoken';

export interface TokenPayload {
  sub: string;
  ver: number;
}

function getSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) {
    throw new Error('AUTH_JWT_SECRET is not set');
  }
  return secret;
}

export function getTokenExpiryDays(): number {
  const raw = Number(process.env.AUTH_TOKEN_EXPIRY_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 7;
}

export function createAccessToken(userId: string, tokenVersion: number): string {
  return jwt.sign({ sub: userId, ver: tokenVersion }, getSecret(), {
    algorithm: 'HS256',
    expiresIn: `${getTokenExpiryDays()}d`,
  });
}

/** 解析并验签 token，失败（过期/签名错误/格式错误）统一返回 null */
export function decodeToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
    if (typeof decoded === 'string') return null;
    const { sub, ver } = decoded as Record<string, unknown>;
    if (typeof sub !== 'string') return null;
    return { sub, ver: typeof ver === 'number' ? ver : 0 };
  } catch {
    return null;
  }
}
