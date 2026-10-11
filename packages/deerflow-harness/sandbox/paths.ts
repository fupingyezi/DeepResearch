/**
 * 沙箱目录解析。
 *
 * 优先级：
 *   - 沙箱根目录：process.env.DEERFLOW_SANDBOX_DIR > {cwd}/.sandbox
 *
 * 线程工作区布局（按线程隔离，父子 agent 共用 threadId 即共用同一目录）：
 *   {base}/threads/{threadId}/user-data/{workspace,uploads,outputs}
 *
 * 范式参考 extensions/paths.ts：cwd 在 Next.js 运行期即仓库根目录。
 */

import * as path from 'node:path';

export interface ThreadDirectories {
  userData: string;
  workspace: string;
  uploads: string;
  outputs: string;
}

export function getSandboxBaseDir(): string {
  const env = process.env.DEERFLOW_SANDBOX_DIR;
  if (env && env.trim().length > 0) return env;
  return path.join(process.cwd(), '.sandbox');
}

export function getThreadDirectories(threadId: string): ThreadDirectories {
  const userData = path.join(getSandboxBaseDir(), 'threads', threadId, 'user-data');
  return {
    userData,
    workspace: path.join(userData, 'workspace'),
    uploads: path.join(userData, 'uploads'),
    outputs: path.join(userData, 'outputs'),
  };
}
