/**
 * provider 注册表：固定序（github → google → qq），也是 providers 下发与
 * 登录页按钮的顺序。未知 provider 与未配置 provider 在 service 同归
 * PROVIDER_DISABLED——不泄露哪些平台曾被配置过。
 */
import type { OAuthProviderAdapter } from './types';
import { createGithubAdapter } from './github';
import { createGoogleAdapter } from './google';
import { createQqAdapter } from './qq';

export function getOAuthAdapters(): OAuthProviderAdapter[] {
  return [createGithubAdapter(), createGoogleAdapter(), createQqAdapter()];
}

export function getOAuthAdapter(provider: string): OAuthProviderAdapter | null {
  return getOAuthAdapters().find((adapter) => adapter.name === provider) ?? null;
}
