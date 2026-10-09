'use client';

import { useState } from 'react';

import { resendVerification } from '@/utils/auth/client';

/**
 * 未验证邮箱提示条：悬浮卡片不占布局（避免重构主区 flex 结构），
 * 用户可一键重发验证邮件。SMTP 未配置时注册即已验证，正常不会出现。
 */
export default function EmailVerifyBanner() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const resend = async () => {
    setError('');
    setLoading(true);
    try {
      await resendVerification();
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed top-4 right-4 z-50 flex items-center gap-3 rounded-xl border border-[#fde68a] bg-[#fffbeb] px-4 py-2.5 text-[13px] text-[#92400e] shadow-sm">
      <span>邮箱未验证，部分功能可能受限。</span>
      {sent ? (
        <span className="text-[#0f766e]">验证邮件已发送，请查收</span>
      ) : (
        <button
          type="button"
          onClick={resend}
          disabled={loading}
          className="cursor-pointer font-medium text-[#0f766e] hover:underline disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? '发送中…' : '重发验证邮件'}
        </button>
      )}
      {error && <span className="text-[#dc2626]">{error}</span>}
    </div>
  );
}
