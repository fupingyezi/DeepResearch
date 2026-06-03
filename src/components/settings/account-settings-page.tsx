'use client';

import { LogoutOutlined } from '@ant-design/icons';
import { useState } from 'react';

import { useAuth } from '@/runtime/context/auth-provider';
import { AuthRequestError, changePassword } from '@/utils/auth/client';

/**
 * 设置弹窗「账号」页：个人信息（邮箱/角色）+ 修改密码 + 退出登录。
 */
export function AccountSettingsPage() {
  const { user, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');

    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    if (newPassword.length < 8) {
      setError('密码至少 8 位');
      return;
    }

    setLoading(true);
    try {
      await changePassword(currentPassword, newPassword);
      setMessage('密码修改成功');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err instanceof AuthRequestError ? err.message : '网络错误，请重试');
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    'h-10 w-full rounded-lg border border-[#e5e7eb] bg-white px-3 text-[14px] outline-none transition-colors focus:border-[#14b8a6]';

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h3 className="mb-3 text-[15px] font-medium text-[#111827]">个人信息</h3>
        <div className="grid grid-cols-[64px_1fr] items-center gap-y-3 text-[14px]">
          <span className="text-[#9ca3af]">邮箱</span>
          <span className="font-medium text-[#374151]">{user?.email ?? '—'}</span>
          <span className="text-[#9ca3af]">角色</span>
          <span className="font-medium text-[#374151] capitalize">{user?.systemRole ?? '—'}</span>
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-[15px] font-medium text-[#111827]">修改密码</h3>
        <p className="mb-3 text-[13px] text-[#9ca3af]">更新你的账号密码。</p>
        <form onSubmit={handleChangePassword} className="flex max-w-sm flex-col gap-3">
          <input
            type="password"
            placeholder="当前密码"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            className={inputClass}
          />
          <input
            type="password"
            placeholder="新密码"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={8}
            className={inputClass}
          />
          <input
            type="password"
            placeholder="确认新密码"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
            className={inputClass}
          />
          {error && <p className="text-[13px] text-[#dc2626]">{error}</p>}
          {message && <p className="text-[13px] text-[#16a34a]">{message}</p>}
          <button
            type="submit"
            disabled={loading}
            className="h-10 w-fit cursor-pointer rounded-lg bg-[#0f766e] px-5 text-[14px] font-medium text-white transition-all hover:bg-[#0d655e] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? '修改中…' : '修改密码'}
          </button>
        </form>
      </section>

      <section>
        <button
          type="button"
          onClick={logout}
          className="flex h-10 w-fit cursor-pointer items-center gap-2 rounded-lg border border-[#dc2626] px-4 text-[14px] font-medium text-[#dc2626] transition-all hover:bg-[#fef2f2]"
        >
          <LogoutOutlined />
          退出登录
        </button>
      </section>
    </div>
  );
}
