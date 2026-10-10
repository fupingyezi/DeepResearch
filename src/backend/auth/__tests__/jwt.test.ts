import { beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';

// 直接走子路径导入，避开 barrel（barrel 的 provider 等模块会拉起 @/lib/db）
import {
  createAccessToken,
  createRefreshToken,
  getAccessTokenExpiryMinutes,
  getTokenExpiryDays,
  verifyAccessToken,
  verifyRefreshToken,
} from '../jwt';

const SECRET = 'test-secret';

beforeEach(() => {
  process.env.AUTH_JWT_SECRET = SECRET;
  delete process.env.AUTH_ACCESS_TOKEN_EXPIRES_MINUTES;
  delete process.env.AUTH_TOKEN_EXPIRY_DAYS;
});

describe('签发与验签 roundtrip', () => {
  it('access：sub/ver/typ 齐备，可验回', () => {
    const token = createAccessToken('u1', 3);
    const payload = verifyAccessToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe('u1');
    expect(payload?.ver).toBe(3);
    expect(payload?.typ).toBe('access');
  });

  it('refresh：sub/ver/typ/jti 齐备，jti 每次轮换不同', () => {
    const a = createRefreshToken('u1', 3);
    const b = createRefreshToken('u1', 3);
    const pa = verifyRefreshToken(a);
    const pb = verifyRefreshToken(b);
    expect(pa?.sub).toBe('u1');
    expect(pa?.ver).toBe(3);
    expect(pa?.typ).toBe('refresh');
    expect(pa?.jti).toBeTruthy();
    expect(pb?.jti).toBeTruthy();
    expect(pa?.jti).not.toBe(pb?.jti);
  });

  it('跨类型互拒：access 塞 refresh 验、refresh 塞 access 验均 null', () => {
    expect(verifyRefreshToken(createAccessToken('u1', 1))).toBeNull();
    expect(verifyAccessToken(createRefreshToken('u1', 1))).toBeNull();
  });

  it('无 typ 的旧版 token 被双验拒（部署即强制重登）', () => {
    const legacy = jwt.sign({ sub: 'u1', ver: 1, sid: 's' }, SECRET, { algorithm: 'HS256' });
    expect(verifyAccessToken(legacy)).toBeNull();
    expect(verifyRefreshToken(legacy)).toBeNull();
  });

  it('过期 token 拒', () => {
    const expired = jwt.sign(
      { sub: 'u1', ver: 1, typ: 'access' },
      SECRET,
      // 直接签已过期的 token：签发函数只产出合法有效期
      { algorithm: 'HS256', expiresIn: '-1s' as `${number}s` },
    );
    expect(verifyAccessToken(expired)).toBeNull();
  });

  it('篡改签名 / 垃圾串 / 空串拒', () => {
    const token = createAccessToken('u1', 1);
    const [header, payload] = token.split('.');
    expect(verifyAccessToken(`${header}.${payload}.tampered`)).toBeNull();
    expect(verifyAccessToken('not-a-jwt')).toBeNull();
    expect(verifyAccessToken('')).toBeNull();
  });

  it('缺 sub / ver 非数字拒', () => {
    const noSub = jwt.sign({ ver: 1, typ: 'access' }, SECRET, { algorithm: 'HS256' });
    const verString = jwt.sign({ sub: 'u1', ver: '1', typ: 'access' }, SECRET, {
      algorithm: 'HS256',
    });
    expect(verifyAccessToken(noSub)).toBeNull();
    expect(verifyAccessToken(verString)).toBeNull();
  });

  it('refresh 缺 jti 拒', () => {
    const noJti = jwt.sign({ sub: 'u1', ver: 1, typ: 'refresh' }, SECRET, { algorithm: 'HS256' });
    expect(verifyRefreshToken(noJti)).toBeNull();
  });

  it('异密钥签名拒', () => {
    const foreign = jwt.sign({ sub: 'u1', ver: 1, typ: 'access' }, 'other-secret', {
      algorithm: 'HS256',
    });
    expect(verifyAccessToken(foreign)).toBeNull();
  });
});

describe('TTL 环境变量', () => {
  it('默认 15 分钟 / 7 天', () => {
    expect(getAccessTokenExpiryMinutes()).toBe(15);
    expect(getTokenExpiryDays()).toBe(7);
  });

  it('env 覆盖生效', () => {
    process.env.AUTH_ACCESS_TOKEN_EXPIRES_MINUTES = '30';
    process.env.AUTH_TOKEN_EXPIRY_DAYS = '14';
    expect(getAccessTokenExpiryMinutes()).toBe(30);
    expect(getTokenExpiryDays()).toBe(14);
  });

  it('非法值回落默认', () => {
    process.env.AUTH_ACCESS_TOKEN_EXPIRES_MINUTES = 'abc';
    process.env.AUTH_TOKEN_EXPIRY_DAYS = '-1';
    expect(getAccessTokenExpiryMinutes()).toBe(15);
    expect(getTokenExpiryDays()).toBe(7);
  });

  it('无 AUTH_JWT_SECRET 时签发抛错', () => {
    delete process.env.AUTH_JWT_SECRET;
    expect(() => createAccessToken('u1', 1)).toThrow(/AUTH_JWT_SECRET/);
  });
});
