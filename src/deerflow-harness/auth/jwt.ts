/**
 * JWT 签发与解析（jsonwebtoken，HS256）。
 *
 * token payload：{ sub: userId, ver: tokenVersion, sid: sessionId, iat, exp }。
 * sid 指向 sessions 表，鉴权时校验未吊销——登出即时生效，不依赖过期。
 * 密钥取自 AUTH_JWT_SECRET 环境变量；过期时长取 AUTH_TOKEN_EXPIRY_DAYS（默认 7 天）。
 * 在 Node runtime 的 API 路由内验签（不在 Edge 中间件做）。
 */

import jwt from 'jsonwebtoken';

export interface TokenPayload {
  sub: string;
  ver: number;
  /** 会话 id（sessions 表）：服务端吊销通道 */
  sid: string;
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

export function createAccessToken(userId: string, tokenVersion: number, sessionId: string): string {
  return jwt.sign({ sub: userId, ver: tokenVersion, sid: sessionId }, getSecret(), {
    algorithm: 'HS256',
    expiresIn: `${getTokenExpiryDays()}d`,
  });
}

/** 解析并验签 token，失败（过期/签名错误/格式错误/缺 sid）统一返回 null */
export function decodeToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
    if (typeof decoded === 'string') return null;
    const { sub, ver, sid } = decoded as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof sid !== 'string') return null;
    return { sub, ver: typeof ver === 'number' ? ver : 0, sid };
  } catch {
    return null;
  }
}

/**
 * 不验签解析（logout 吊销用）：token 可能已过期/版本落后，只要能读出 sid 即可吊销。
 * 吊销对象是随机 UUID 会话 id，伪造 token 无法定向吊销他人会话，无放大风险。
 */
export function decodeTokenUnverified(token: string): TokenPayload | null {
  try {
    const decoded = jwt.decode(token);
    if (!decoded || typeof decoded === 'string') return null;
    const { sub, ver, sid } = decoded as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof sid !== 'string') return null;
    return { sub, ver: typeof ver === 'number' ? ver : 0, sid };
  } catch {
    return null;
  }
}
