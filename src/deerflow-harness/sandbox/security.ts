/**
 * 安全门控：LocalSandbox 在宿主机直接执行 bash，**不是**安全隔离边界，因此
 * host bash 默认禁用，必须显式设置环境变量 `DEERFLOW_ALLOW_HOST_BASH=true`（或 1）
 * 才放行——对齐 deer-flow `sandbox.allow_host_bash`，遵循 project.md secrets=env-only。
 *
 * 该门控仅作用于非隔离后端（Local）。Docker 等具内核级隔离的后端由 provider
 * isSecureIsolation() 声明为安全边界，bash 工具直接放行、不经此门控。
 *
 * 即使放行，工具层仍对命令做绝对路径白名单与路径穿越校验（best-effort，非隔离）。
 */

export const LOCAL_HOST_BASH_DISABLED_MESSAGE =
  'Host bash execution is disabled because LocalSandbox is not a secure isolation boundary. ' +
  'Set DEERFLOW_ALLOW_HOST_BASH=true only in a fully trusted local environment to enable it.';

export function isHostBashAllowed(): boolean {
  const value = process.env.DEERFLOW_ALLOW_HOST_BASH;
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}
