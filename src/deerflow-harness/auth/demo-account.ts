/**
 * 体验账号（demo login）。
 *
 * 凭证只放服务器环境变量（AUTH_DEMO_EMAIL / AUTH_DEMO_PASSWORD），两者都非空才启用。
 * 密码绝不下发给前端——setup-status 只暴露 enabled + email 用于展示一键体验入口。
 */

export interface DemoAccount {
  email: string;
  password: string;
}

export function getDemoAccount(): DemoAccount | null {
  const email = process.env.AUTH_DEMO_EMAIL?.trim();
  const password = process.env.AUTH_DEMO_PASSWORD;
  if (!email || !password) return null;
  return { email, password };
}
