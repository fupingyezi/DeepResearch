/**
 * OAuth 登录编排服务（app 层）：state 校验 → 换 token → 绑定决策树 → 建号。
 *
 * 本服务不碰 NextRequest/NextResponse（auth-service 先例）：redirect_uri 由
 * 路由层算好传入，会话 token 也由路由层调 getAuthService().issueSessionToken
 * 签发——service 只返回 UserRecord。
 *
 * 绑定决策树（顺序即不变量，注释对应 handleCallback 步骤）：
 * ① adapter 缺失/未配置 → PROVIDER_DISABLED
 * ② state 校验（在 code 交换之前 fail-fast：伪造/缺失直接短路，不消耗
 *    第三方 code 的交换机会）
 * ③ exchange 失败 → EXCHANGE_FAILED
 * ④ email 缺失 → NO_EMAIL
 * ⑤ 绑定命中 → 登录
 * ⑥ 邮箱撞已有本地账号且无绑定行 → EMAIL_TAKEN 安全拒绝（防账号抢占，
 *    绝不自动绑定；「已登录用户绑定 OAuth」不在本阶段范围）
 * ⑦ 建号（passwordHash=null，emailVerified 取平台声明）
 * ⑧ 写绑定行；唯一冲突 → 回查现有绑定登录（并发回调的防御分支）
 *
 * 事务注记：harness 的 createUser 不收 db 参数，无法与绑定 insert 同事务。
 * 顺序本身使孤儿不可达：同一 provider 用户 ⇒ 同一邮箱（合成邮箱对
 * providerUserId 确定）⇒ 并发输家在建号步就吃 23505；⑧ 的 23505 只可能
 * 出现在「平台邮箱已变更」的罕见场景，回查兜底即可，不需要 withTransaction。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { UserRecord } from '@deerflow-harness/auth';
import {
  EmailExistsError,
  createUser,
  getUserByEmail,
  getUserById,
} from '@deerflow-harness/auth/user-repository';
import {
  OAuthAdapterError,
  getOAuthAdapters,
  type OAuthProviderAdapter,
  type OAuthProviderName,
  type OAuthUserInfo,
} from '@/lib/oauth';
import {
  OAuthAccountExistsError,
  PgOAuthAccountStore,
  type OAuthAccountStore,
} from '@/server/daos/oauth-account';

export type OAuthErrorCode =
  | 'PROVIDER_DISABLED'
  | 'STATE_MISMATCH'
  | 'EXCHANGE_FAILED'
  | 'NO_EMAIL'
  | 'EMAIL_TAKEN'
  | 'PROVIDER_ERROR';

export class OAuthServiceError extends Error {
  constructor(
    public readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthServiceError';
  }
}

export interface OAuthServiceDeps {
  oauthAccounts?: OAuthAccountStore;
  adapters?: OAuthProviderAdapter[];
}

export interface OAuthService {
  listConfiguredProviders(): OAuthProviderName[];
  /** 生成 authorize 跳转与 CSRF state；provider 未配置抛 PROVIDER_DISABLED */
  begin(provider: string, redirectUri: string): { redirectUrl: string; state: string };
  /** 完整回调编排：state 校验 → 交换 → 绑定决策 → 返回用户；失败抛 OAuthServiceError */
  handleCallback(
    provider: string,
    code: string,
    state: string | null,
    cookieState: string | null,
    redirectUri: string,
  ): Promise<UserRecord>;
}

function statesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function createOAuthService(deps: OAuthServiceDeps = {}): OAuthService {
  const adapters = deps.adapters ?? getOAuthAdapters();
  const accounts = deps.oauthAccounts ?? new PgOAuthAccountStore();

  /** 未知 provider 与未配置同归 PROVIDER_DISABLED：不泄露枚举信息 */
  function resolveAdapter(provider: string): OAuthProviderAdapter {
    const adapter = adapters.find((a) => a.name === provider);
    if (!adapter || !adapter.isConfigured()) {
      throw new OAuthServiceError('PROVIDER_DISABLED', `OAuth provider '${provider}' disabled`);
    }
    return adapter;
  }

  return {
    listConfiguredProviders() {
      return adapters.filter((a) => a.isConfigured()).map((a) => a.name);
    },

    begin(provider, redirectUri) {
      const adapter = resolveAdapter(provider);
      const state = randomBytes(32).toString('hex');
      return { redirectUrl: adapter.buildAuthorizeUrl(state, redirectUri), state };
    },

    async handleCallback(provider, code, state, cookieState, redirectUri) {
      const adapter = resolveAdapter(provider);

      // state 只存在于 begin 种下的 httpOnly cookie：攻击者无法在 api 域种
      // cookie，state 匹配 ⟺ 回调必然流经我们的 begin 端点（CSRF 防线）
      if (!cookieState || !state || !statesEqual(cookieState, state)) {
        throw new OAuthServiceError('STATE_MISMATCH', 'oauth state mismatch');
      }

      let info: OAuthUserInfo;
      try {
        info = await adapter.exchange(code, redirectUri);
      } catch (error) {
        if (error instanceof OAuthAdapterError) {
          console.warn('[oauth] exchange failed:', adapter.name, error.stage);
          throw new OAuthServiceError('EXCHANGE_FAILED', error.message);
        }
        throw error;
      }

      if (!info.email) {
        throw new OAuthServiceError('NO_EMAIL', 'provider returned no usable email');
      }
      const email = info.email.trim().toLowerCase();

      const binding = await accounts.findByProvider(adapter.name, info.providerUserId);
      if (binding) {
        const user = await getUserById(binding.userId);
        if (!user) {
          // 外键级联理论上不产生悬空绑定行，出现即数据异常：拒绝而不是崩溃
          console.error('[oauth] binding points to missing user', binding);
          throw new OAuthServiceError('EXCHANGE_FAILED', 'binding points to missing user');
        }
        return user;
      }

      if (await getUserByEmail(email)) {
        throw new OAuthServiceError(
          'EMAIL_TAKEN',
          'email belongs to a local account without oauth binding',
        );
      }

      let user: UserRecord;
      try {
        user = await createUser({
          email,
          passwordHash: null,
          systemRole: 'user',
          needsSetup: false,
          emailVerified: info.emailVerified,
        });
      } catch (error) {
        if (error instanceof EmailExistsError) {
          // 并发回调竞态：另一路已建号并绑定
          throw new OAuthServiceError('EMAIL_TAKEN', 'email exists');
        }
        throw error;
      }

      try {
        await accounts.create(user.id, adapter.name, info.providerUserId);
      } catch (error) {
        if (error instanceof OAuthAccountExistsError) {
          const existing = await accounts.findByProvider(adapter.name, info.providerUserId);
          if (existing) {
            const boundUser = await getUserById(existing.userId);
            if (boundUser) return boundUser;
          }
        }
        throw error;
      }
      return user;
    },
  };
}

let _oauthService: OAuthService | null = null;

export function getOAuthService(): OAuthService {
  if (!_oauthService) _oauthService = createOAuthService();
  return _oauthService;
}
