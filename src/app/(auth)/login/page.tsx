'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

import { useAuth } from '@/events/context/auth-provider';
import type { UserResponse } from '@deerflow-harness/auth/types';
import {
  AuthRequestError,
  demoLogin,
  fetchOAuthProviders,
  fetchSetupStatus,
  forgotPassword,
  login as loginRequest,
  oauthLoginUrl,
  register as registerRequest,
  type OAuthProviderName,
} from '@/utils/auth/client';

type Mode = 'login' | 'register' | 'forgot';

/** OAuth 回调失败回跳 /login?oauth_error=X 的文案映射（后端错误码 → 用户话术） */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  PROVIDER_DISABLED: '该登录方式未配置',
  STATE_MISMATCH: '登录校验失败，请重新发起登录',
  EXCHANGE_FAILED: '第三方授权失败，请稍后重试',
  NO_EMAIL: '该账号未提供可用邮箱，无法登录',
  EMAIL_TAKEN: '该邮箱已注册本地账号，为安全起见未自动关联，请使用邮箱密码登录',
  PROVIDER_ERROR: '第三方登录被取消或失败，请重试',
};

const OAUTH_PROVIDER_LABELS: Record<OAuthProviderName, string> = {
  github: 'GitHub 登录',
  google: 'Google 登录',
  qq: 'QQ 登录',
};

export default function LoginPage() {
  const router = useRouter();
  const { applyUser } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  // forgot 模式提交成功后的提示（服务端响应恒定，防枚举）
  const [sentMessage, setSentMessage] = useState('');
  const [loading, setLoading] = useState(false);
  // 服务器配置了体验账号（AUTH_DEMO_EMAIL/PASSWORD）时为该邮箱，否则 null
  const [demoEmail, setDemoEmail] = useState<string | null>(null);
  // REGISTRATION_ENABLED 关闭时隐藏注册入口
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  // 已配置的 OAuth 第三方登录（未配置任何平台时为空，按钮隐藏）
  const [oauthProviders, setOauthProviders] = useState<OAuthProviderName[]>([]);

  // 无 admin 时引导到首启设置页
  useEffect(() => {
    fetchSetupStatus().then((status) => {
      if (status.needs_setup) router.replace('/setup');
      if (status.demo_login.enabled) setDemoEmail(status.demo_login.email);
      setRegistrationEnabled(status.registration.enabled);
    });
  }, [router]);

  // OAuth 按钮：只渲染服务端确认已配置的平台
  useEffect(() => {
    fetchOAuthProviders().then(setOauthProviders);
  }, []);

  // OAuth 回调失败回跳：读一次 oauth_error 提示并剥掉参数，刷新不会重复提示。
  // 必须在 useEffect 里读 window：SSR 阶段 window 不存在
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('oauth_error');
    if (!code) return;
    setError(OAUTH_ERROR_MESSAGES[code] ?? 'OAuth 登录失败，请重试');
    const next = new URL(window.location.href);
    next.searchParams.delete('oauth_error');
    window.history.replaceState(null, '', next.pathname + next.search);
  }, []);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError('');
    setSentMessage('');
  };

  const runLogin = async (action: () => Promise<UserResponse>) => {
    setError('');
    setLoading(true);
    try {
      applyUser(await action());
      // 硬导航整页跳转：确保 HttpOnly cookie 已写入、middleware 重新放行 /，
      // 规避软导航命中 Router 缓存的"未登录重定向"导致 URL 停留 /login。
      window.location.assign('/');
    } catch (err) {
      setError(err instanceof AuthRequestError ? err.message : 'Network error, please try again');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'forgot') {
      setError('');
      setLoading(true);
      try {
        await forgotPassword(email);
        setSentMessage('如果该邮箱已注册，重置邮件已发送');
      } catch (err) {
        setError(err instanceof AuthRequestError ? err.message : 'Network error, please try again');
      } finally {
        setLoading(false);
      }
      return;
    }
    await runLogin(() =>
      mode === 'login' ? loginRequest(email, password) : registerRequest(email, password),
    );
  };

  const title = mode === 'login' ? '欢迎回来' : mode === 'register' ? '创建账号' : '找回密码';
  const submitLabel =
    mode === 'login' ? '登录' : mode === 'register' ? '注册并登录' : '发送重置邮件';

  return (
    <div className="flex h-screen w-full items-center justify-center bg-[#f9fafb]">
      <div className="w-[380px] rounded-2xl border border-[#e5e7eb] bg-white p-8 shadow-[0_8px_30px_rgba(16,24,40,0.08)]">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Image src="/四叶草.svg" alt="logo" width={48} height={48} className="rounded-xl" />
          <h1 className="text-[20px] font-semibold text-[#111827]">{title}</h1>
          <p className="text-[13px] text-[#9ca3af]">mini-DeepResearch</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="email"
            placeholder="邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="h-11 rounded-xl border border-[#e5e7eb] bg-white px-4 text-[14px] transition-colors outline-none focus:border-[#14b8a6]"
          />
          {mode !== 'forgot' && (
            <input
              type="password"
              placeholder="密码（至少 8 位）"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="h-11 rounded-xl border border-[#e5e7eb] bg-white px-4 text-[14px] transition-colors outline-none focus:border-[#14b8a6]"
            />
          )}

          {error && <p className="text-[13px] text-[#dc2626]">{error}</p>}
          {sentMessage && <p className="text-[13px] text-[#0f766e]">{sentMessage}</p>}

          <button
            type="submit"
            disabled={loading}
            className="mt-1 h-11 rounded-xl bg-[#0f766e] text-[14px] font-medium text-white transition-all hover:bg-[#0d655e] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? '请稍候…' : submitLabel}
          </button>
        </form>

        {(demoEmail !== null || oauthProviders.length > 0) && mode !== 'forgot' && (
          <>
            <div className="mt-5 flex items-center gap-3" aria-hidden>
              <span className="h-px flex-1 bg-[#e5e7eb]" />
              <span className="text-[12px] text-[#9ca3af]">或</span>
              <span className="h-px flex-1 bg-[#e5e7eb]" />
            </div>
            {demoEmail !== null && (
              <button
                type="button"
                onClick={() => runLogin(demoLogin)}
                disabled={loading}
                className="mt-3 h-11 w-full rounded-xl border border-[#14b8a6] bg-white text-[14px] font-medium text-[#0f766e] transition-all hover:bg-[#f0fdfa] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {demoEmail ? `一键体验（${demoEmail}）` : '一键体验登录'}
              </button>
            )}
            {oauthProviders.map((provider) => (
              <button
                key={provider}
                type="button"
                // 顶层导航跳转：302 链（begin → provider 授权页 → callback → 首页）
                // 走完浏览器自然回到应用，不能走 fetch（会拿不到 cookie 域语义）
                onClick={() => {
                  window.location.href = oauthLoginUrl(provider);
                }}
                disabled={loading}
                className="mt-3 h-11 w-full rounded-xl border border-[#e5e7eb] bg-white text-[14px] font-medium text-[#374151] transition-all hover:bg-[#f9fafb] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {OAUTH_PROVIDER_LABELS[provider]}
              </button>
            ))}
          </>
        )}

        <div className="mt-5 text-center text-[13px] text-[#9ca3af]">
          {mode === 'login' ? (
            <>
              {registrationEnabled ? (
                <>
                  还没有账号？
                  <button
                    type="button"
                    onClick={() => switchMode('register')}
                    className="ml-1 cursor-pointer font-medium text-[#0f766e] hover:underline"
                  >
                    注册
                  </button>
                </>
              ) : (
                <>注册暂未开放</>
              )}
              <span className="mx-2">·</span>
              <button
                type="button"
                onClick={() => switchMode('forgot')}
                className="cursor-pointer font-medium text-[#0f766e] hover:underline"
              >
                忘记密码
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => switchMode('login')}
              className="cursor-pointer font-medium text-[#0f766e] hover:underline"
            >
              {mode === 'register' ? '已有账号？去登录' : '返回登录'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
