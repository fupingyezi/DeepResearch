/**
 * 虚拟路径工具：在「模型可见的虚拟路径 /mnt/user-data/*」与「宿主真实路径」之间
 * 做映射、安全校验与输出脱敏。是 sandbox 文件工具的安全核心。
 *
 * 安全不变量（触发条件 + 后果 + 对策）：
 * - 路径穿越：路径含 `..` 段时直接拒绝（防越权访问 thread 目录之外）。
 * - 越界落点：虚拟路径替换为真实路径后，必须 path.resolve 并校验仍落在
 *   workspace/uploads/outputs 三根目录之内，否则拒绝（防符号/拼接逃逸）。
 * - 命令注入路径：bash 命令里出现非白名单绝对路径或 file:// 时拒绝（best-effort，
 *   非隔离边界）。
 * - 信息泄漏：工具输出中的宿主绝对路径反向替换回 /mnt/user-data，避免暴露宿主布局。
 */

import * as path from 'node:path';

import type { ThreadDataState } from '../agents/thread-state';
import { SandboxPermissionError, SandboxRuntimeError } from './exceptions';

export const VIRTUAL_PATH_PREFIX = '/mnt/user-data';

const ABSOLUTE_PATH_PATTERN = /(?<![:\w])(?<!:\/)\/(?:[^\s"'`;&|<>()]+)/g;
const FILE_URL_PATTERN = /\bfile:\/\/\S+/i;
const URL_IN_COMMAND_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`;&|<>()]+/gi;

const SYSTEM_PATH_PREFIXES = [
  '/bin/',
  '/usr/bin/',
  '/usr/sbin/',
  '/sbin/',
  '/opt/homebrew/bin/',
  '/dev/',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rejectPathTraversal(targetPath: string): void {
  const normalized = targetPath.split('\\').join('/');
  for (const segment of normalized.split('/')) {
    if (segment === '..') {
      throw new SandboxPermissionError('Access denied: path traversal detected', targetPath);
    }
  }
}

/** 构建虚拟前缀 → 实际目录的映射（含三子目录及共同父目录的虚拟根）。 */
function virtualToActualMappings(threadData: ThreadDataState): Record<string, string> {
  const mappings: Record<string, string> = {};
  const { workspacePath, uploadsPath, outputsPath } = threadData;

  if (workspacePath) mappings[`${VIRTUAL_PATH_PREFIX}/workspace`] = workspacePath;
  if (uploadsPath) mappings[`${VIRTUAL_PATH_PREFIX}/uploads`] = uploadsPath;
  if (outputsPath) mappings[`${VIRTUAL_PATH_PREFIX}/outputs`] = outputsPath;

  const actualDirs = [workspacePath, uploadsPath, outputsPath].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  if (actualDirs.length > 0) {
    const commonParent = path.dirname(actualDirs[0]);
    if (actualDirs.every((p) => path.dirname(p) === commonParent)) {
      mappings[VIRTUAL_PATH_PREFIX] = commonParent;
    }
  }
  return mappings;
}

function allowedRoots(threadData: ThreadDataState): string[] {
  return [threadData.workspacePath, threadData.uploadsPath, threadData.outputsPath]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => path.resolve(p));
}

function isWithin(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 把单个虚拟路径替换为真实路径（按最长前缀匹配）；无映射命中则原样返回。 */
export function replaceVirtualPath(
  targetPath: string,
  threadData: ThreadDataState | null | undefined,
): string {
  if (!threadData) return targetPath;
  const mappings = virtualToActualMappings(threadData);
  const sortedKeys = Object.keys(mappings).sort((a, b) => b.length - a.length);
  for (const virtualBase of sortedKeys) {
    const actualBase = mappings[virtualBase];
    if (targetPath === virtualBase) return actualBase;
    if (targetPath.startsWith(`${virtualBase}/`)) {
      const rest = targetPath.slice(virtualBase.length).replace(/^\/+/, '');
      return path.join(actualBase, rest);
    }
  }
  return targetPath;
}

/** 安全门：校验虚拟路径是否允许访问（仅 /mnt/user-data/* 放行）。 */
export function validateLocalToolPath(
  targetPath: string,
  threadData: ThreadDataState | null | undefined,
): void {
  if (!threadData) {
    throw new SandboxRuntimeError('Thread data not available for local sandbox');
  }
  rejectPathTraversal(targetPath);
  if (targetPath === VIRTUAL_PATH_PREFIX || targetPath.startsWith(`${VIRTUAL_PATH_PREFIX}/`)) {
    return;
  }
  throw new SandboxPermissionError(
    `Only paths under ${VIRTUAL_PATH_PREFIX}/ are allowed`,
    targetPath,
  );
}

/** 替换虚拟路径为真实路径并校验落点仍在 thread 三目录内，返回真实路径。 */
export function resolveAndValidateUserDataPath(
  targetPath: string,
  threadData: ThreadDataState,
): string {
  const resolvedStr = replaceVirtualPath(targetPath, threadData);
  const resolved = path.resolve(resolvedStr);
  const roots = allowedRoots(threadData);
  if (roots.length === 0) {
    throw new SandboxRuntimeError('No allowed local sandbox directories configured');
  }
  for (const root of roots) {
    if (isWithin(resolved, root)) return resolved;
  }
  throw new SandboxPermissionError('Access denied: path traversal detected', targetPath);
}

/** 输出脱敏：把宿主真实路径反向替换回 /mnt/user-data 虚拟路径。 */
export function maskLocalPathsInOutput(
  output: string,
  threadData: ThreadDataState | null | undefined,
): string {
  if (!threadData) return output;
  const mappings = virtualToActualMappings(threadData);
  const actualToVirtual = Object.entries(mappings)
    .map(([virtualBase, actualBase]) => ({ virtualBase, actualBase: path.resolve(actualBase) }))
    .sort((a, b) => b.actualBase.length - a.actualBase.length);

  let result = output;
  for (const { virtualBase, actualBase } of actualToVirtual) {
    const pattern = new RegExp(`${escapeRegExp(actualBase)}(?:[/\\\\][^\\s"';&|<>()]*)?`, 'g');
    result = result.replace(pattern, (matched) => {
      if (matched === actualBase) return virtualBase;
      const relative = matched.slice(actualBase.length).replace(/^[/\\]+/, '');
      return relative ? `${virtualBase}/${relative.split('\\').join('/')}` : virtualBase;
    });
  }
  return result;
}

function isAllowedBashAbsolutePath(absolutePath: string): boolean {
  if (absolutePath === VIRTUAL_PATH_PREFIX || absolutePath.startsWith(`${VIRTUAL_PATH_PREFIX}/`)) {
    rejectPathTraversal(absolutePath);
    return true;
  }
  return SYSTEM_PATH_PREFIXES.some(
    (prefix) => absolutePath === prefix.replace(/\/$/, '') || absolutePath.startsWith(prefix),
  );
}

function nonFileUrlSpans(command: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of command.matchAll(URL_IN_COMMAND_PATTERN)) {
    const value = match[0];
    if (!value.toLowerCase().startsWith('file://') && match.index !== undefined) {
      spans.push([match.index, match.index + value.length]);
    }
  }
  return spans;
}

/**
 * 校验 bash 命令里的绝对路径（best-effort，非隔离边界）：
 * - 拒绝 file:// URL（绕过绝对路径正则却可读宿主文件）；
 * - 命令中的绝对路径必须落在 /mnt/user-data 或系统可执行/设备白名单前缀下，否则拒绝。
 */
export function validateBashCommandPaths(
  command: string,
  threadData: ThreadDataState | null | undefined,
): void {
  if (!threadData) {
    throw new SandboxRuntimeError('Thread data not available for local sandbox');
  }

  const fileUrlMatch = FILE_URL_PATTERN.exec(command);
  if (fileUrlMatch) {
    throw new SandboxPermissionError(
      `Unsafe file:// URL in command: ${fileUrlMatch[0]}. Use paths under ${VIRTUAL_PATH_PREFIX}`,
    );
  }

  const urlSpans = nonFileUrlSpans(command);
  const unsafe = new Set<string>();
  for (const match of command.matchAll(ABSOLUTE_PATH_PATTERN)) {
    if (match.index === undefined) continue;
    if (urlSpans.some(([start, end]) => match.index! >= start && match.index! < end)) continue;
    const absolutePath = match[0];
    if (absolutePath.includes('/../') || absolutePath.endsWith('/..')) {
      throw new SandboxPermissionError('Access denied: path traversal detected', absolutePath);
    }
    if (!isAllowedBashAbsolutePath(absolutePath)) unsafe.add(absolutePath);
  }

  if (unsafe.size > 0) {
    throw new SandboxPermissionError(
      `Unsafe absolute paths in command: ${[...unsafe].join(', ')}. Use paths under ${VIRTUAL_PATH_PREFIX}`,
    );
  }
}

/** 把命令字符串里的虚拟路径整体替换为真实路径。 */
export function replaceVirtualPathsInCommand(
  command: string,
  threadData: ThreadDataState | null | undefined,
): string {
  if (!threadData) return command;
  const pattern = new RegExp(`${escapeRegExp(VIRTUAL_PATH_PREFIX)}(/[^\\s"';&|<>()]*)?`, 'g');
  return command.replace(pattern, (matched) => replaceVirtualPath(matched, threadData));
}
