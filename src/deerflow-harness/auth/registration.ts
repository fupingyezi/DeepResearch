/**
 * 注册开关：REGISTRATION_ENABLED（默认开），'0'/'false' 显式关闭。
 *
 * 关闭时 /api/auth/register 返回 403，setup-status 下发 registration.enabled=false，
 * 前端登录页隐藏注册入口。开放注册的防滥用前提是限流与邮箱验证（见 Phase 2）。
 */

export function isRegistrationEnabled(): boolean {
  const raw = process.env.REGISTRATION_ENABLED;
  return !(raw === '0' || raw === 'false');
}
