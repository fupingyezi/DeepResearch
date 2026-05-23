/**
 * 优先级：
 *   process.env.DEERFLOW_DATA_DIR > ~/.deer-flow
 *
 * 4 种 memory 文件路径策略：
 *   - 全局：           {base}/memory.json
 *   - per-agent：      {base}/agents/{name}/memory.json
 *   - per-user：       {base}/users/{user_id}/memory.json
 *   - per-user-agent： {base}/users/{user_id}/agents/{name}/memory.json
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { validateAgentName } from './types';

export function getBaseDir(): string {
  const env = process.env.DEERFLOW_DATA_DIR;
  if (env && env.trim().length > 0) return env;
  return path.join(os.homedir(), '.deer-flow');
}

export function memoryFile(): string {
  return path.join(getBaseDir(), 'memory.json');
}

export function agentMemoryFile(agentName: string): string {
  validateAgentName(agentName);
  return path.join(getBaseDir(), 'agents', agentName, 'memory.json');
}

export function userMemoryFile(userId: string): string {
  if (!userId) throw new Error('userId must be a non-empty string');
  return path.join(getBaseDir(), 'users', userId, 'memory.json');
}

export function userAgentMemoryFile(userId: string, agentName: string): string {
  if (!userId) throw new Error('userId must be a non-empty string');
  validateAgentName(agentName);
  return path.join(getBaseDir(), 'users', userId, 'agents', agentName, 'memory.json');
}
