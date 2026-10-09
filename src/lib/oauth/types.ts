/**
 * OAuth provider 适配器契约：纯 HTTP（无 SQL、无请求上下文），每个 adapter
 * 掌握本平台的端点、env 契约与响应格式怪癖。合成邮箱策略属 provider 语义，
 * 在 adapter 内完成——service 只看到最终 email。
 */

export type OAuthProviderName = 'github' | 'google' | 'qq';

export interface OAuthUserInfo {
  /** 平台内稳定标识：GitHub=String(id)、Google=sub、QQ=openid */
  providerUserId: string;
  /** 最终邮箱（含合成邮箱）；null = 平台不提供且无法合成，service 走 NO_EMAIL */
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

export interface OAuthProviderAdapter {
  readonly name: OAuthProviderName;
  /** client_id 与 client_secret 同时非空才算启用（每次实时读 env） */
  isConfigured(): boolean;
  buildAuthorizeUrl(state: string, redirectUri: string): string;
  exchange(code: string, redirectUri: string): Promise<OAuthUserInfo>;
}

/** adapter 内网络/解析失败统一抛此错（带 provider + 阶段）；service 转译 EXCHANGE_FAILED */
export class OAuthAdapterError extends Error {
  constructor(
    public readonly provider: OAuthProviderName,
    public readonly stage: string,
    detail: string,
  ) {
    super(detail);
    this.name = 'OAuthAdapterError';
  }
}
