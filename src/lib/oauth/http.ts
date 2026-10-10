/**
 * adapter 共用的裸 fetch：10s 超时（OAuth 是交互链路，长了只会拖慢回调）；
 * 非 2xx 统一抛 OAuthAdapterError（带 provider + 阶段），不把平台细节抛给上层。
 */
import { OAuthAdapterError, type OAuthProviderName } from './types';

export async function oauthFetch(
  provider: OAuthProviderName,
  stage: string,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new OAuthAdapterError(provider, stage, (error as Error).message);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new OAuthAdapterError(provider, stage, `${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}
