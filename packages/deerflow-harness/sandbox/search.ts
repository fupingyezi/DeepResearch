/**
 * 文件检索底座：glob（按模式找路径）与 grep（按内容找行）。
 *
 * 保留三道防护：
 * - IGNORE_PATTERNS 跳过依赖/构建/缓存等噪声目录与文件；
 * - grep 跳过二进制文件、超过大小上限的文件，并跳过超长行（防 ReDoS）；
 * - 命中 maxResults 即截断并返回 truncated 标志。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { GrepMatch } from './sandbox';

const IGNORE_PATTERNS: string[] = [
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.env',
  'env',
  '.tox',
  '.nox',
  '.eggs',
  '*.egg-info',
  'site-packages',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  'target',
  'out',
  '.idea',
  '.vscode',
  '*.swp',
  '*.swo',
  '*~',
  '.project',
  '.classpath',
  '.settings',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '*.lnk',
  '*.log',
  '*.tmp',
  '*.temp',
  '*.bak',
  '*.cache',
  '.cache',
  'logs',
  '.coverage',
  'coverage',
  '.nyc_output',
  'htmlcov',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
];

const DEFAULT_MAX_FILE_SIZE_BYTES = 1_000_000;
const DEFAULT_LINE_SUMMARY_LENGTH = 200;
const BINARY_SAMPLE_SIZE = 8192;

/** 把 glob 通配符转成锚定整段路径的正则（支持 `*` / `**` / `?`）。 */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**` 跨目录匹配（含 `/`）
        source += '.*';
        i += 2;
        if (pattern[i] === '/') i += 1;
        continue;
      }
      source += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      i += 1;
      continue;
    }
    source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${source}$`);
}

function shouldIgnoreName(name: string): boolean {
  for (const pattern of IGNORE_PATTERNS) {
    if (pattern.includes('*')) {
      if (globToRegExp(pattern).test(name)) return true;
    } else if (name === pattern) {
      return true;
    }
  }
  return false;
}

function pathMatches(pattern: string, relPath: string): boolean {
  const normalized = relPath.split(path.sep).join('/');
  if (globToRegExp(pattern).test(normalized)) return true;
  if (pattern.startsWith('**/')) {
    return globToRegExp(pattern.slice(3)).test(normalized);
  }
  return false;
}

function truncateLine(line: string, maxChars: number = DEFAULT_LINE_SUMMARY_LENGTH): string {
  const trimmed = line.replace(/[\n\r]+$/, '');
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars - 3) + '...';
}

function isBinaryFile(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(BINARY_SAMPLE_SIZE);
    const bytesRead = fs.readSync(fd, buffer, 0, BINARY_SAMPLE_SIZE, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore close error */
      }
    }
  }
}

/** 递归遍历目录，跳过 ignore 项；对每个文件回调，返回值为 false 时提前终止。 */
function walkFiles(
  root: string,
  onEntry: (absPath: string, relPath: string, isDir: boolean) => boolean,
): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (shouldIgnoreName(entry.name)) continue;
      const absPath = path.join(current, entry.name);
      const relPath = path.relative(root, absPath);
      const isDir = entry.isDirectory();
      if (!onEntry(absPath, relPath, isDir)) return;
      if (isDir) stack.push(absPath);
    }
  }
}

export function findGlobMatches(
  root: string,
  pattern: string,
  opts: { includeDirs?: boolean; maxResults?: number } = {},
): { matches: string[]; truncated: boolean } {
  const includeDirs = opts.includeDirs ?? false;
  const maxResults = opts.maxResults ?? 200;
  const resolvedRoot = path.resolve(root);

  if (!fs.existsSync(resolvedRoot)) throw new SandboxFsError('ENOENT', resolvedRoot);
  if (!fs.statSync(resolvedRoot).isDirectory()) throw new SandboxFsError('ENOTDIR', resolvedRoot);

  const matches: string[] = [];
  let truncated = false;

  walkFiles(resolvedRoot, (absPath, relPath, isDir) => {
    if (isDir && !includeDirs) return true;
    if (pathMatches(pattern, relPath)) {
      matches.push(absPath);
      if (matches.length >= maxResults) {
        truncated = true;
        return false;
      }
    }
    return true;
  });

  return { matches, truncated };
}

export function findGrepMatches(
  root: string,
  pattern: string,
  opts: {
    globPattern?: string | null;
    literal?: boolean;
    caseSensitive?: boolean;
    maxResults?: number;
  } = {},
): { matches: GrepMatch[]; truncated: boolean } {
  const globPattern = opts.globPattern ?? null;
  const literal = opts.literal ?? false;
  const caseSensitive = opts.caseSensitive ?? false;
  const maxResults = opts.maxResults ?? 100;
  const resolvedRoot = path.resolve(root);

  if (!fs.existsSync(resolvedRoot)) throw new SandboxFsError('ENOENT', resolvedRoot);
  if (!fs.statSync(resolvedRoot).isDirectory()) throw new SandboxFsError('ENOTDIR', resolvedRoot);

  const regexSource = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
  const regex = new RegExp(regexSource, caseSensitive ? '' : 'i');
  const maxLineChars = DEFAULT_LINE_SUMMARY_LENGTH * 10;

  const matches: GrepMatch[] = [];
  let truncated = false;

  walkFiles(resolvedRoot, (absPath, relPath, isDir) => {
    if (isDir) return true;
    if (globPattern !== null && !pathMatches(globPattern, relPath)) return true;
    try {
      const stat = fs.lstatSync(absPath);
      if (stat.isSymbolicLink()) return true;
      if (stat.size > DEFAULT_MAX_FILE_SIZE_BYTES) return true;
      if (isBinaryFile(absPath)) return true;
      const content = fs.readFileSync(absPath, 'utf-8');
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.length > maxLineChars) continue;
        if (regex.test(line)) {
          matches.push({
            path: absPath,
            lineNumber: index + 1,
            line: truncateLine(line),
          });
          if (matches.length >= maxResults) {
            truncated = true;
            return false;
          }
        }
      }
    } catch {
      return true;
    }
    return true;
  });

  return { matches, truncated };
}

export { shouldIgnoreName };

/** 携带 errno code 的文件系统错误，供调用方区分 ENOENT / ENOTDIR。 */
export class SandboxFsError extends Error {
  readonly code: string;
  readonly targetPath: string;

  constructor(code: string, targetPath: string) {
    super(`${code}: ${targetPath}`);
    this.name = 'SandboxFsError';
    this.code = code;
    this.targetPath = targetPath;
  }
}
