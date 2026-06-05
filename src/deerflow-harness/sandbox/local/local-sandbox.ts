/**
 * LocalSandbox：在宿主文件系统上实现 Sandbox 能力。
 *
 * 所有入参路径均为「已由工具层解析 + 校验过的宿主真实路径」——本类不做虚拟路径
 * 映射，仅负责实际的进程执行与文件 IO。命令执行用 execFile 单次派发到 shell
 * （`shell -c command`），避免在 JS 层再做字符串拼接式注入。
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  Sandbox,
  type GlobOptions,
  type GlobResult,
  type GrepOptions,
  type GrepResult,
} from '../sandbox';
import { findGlobMatches, findGrepMatches } from '../search';
import { listDir } from '../list-dir';

const COMMAND_TIMEOUT_MS = 600_000;
const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

function resolveShell(): string {
  if (os.platform() === 'win32') {
    return process.env.ComSpec || 'cmd.exe';
  }
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '/bin/sh';
}

export class LocalSandbox extends Sandbox {
  async executeCommand(command: string): Promise<string> {
    const shell = resolveShell();
    const shellArgs = os.platform() === 'win32' ? ['/c', command] : ['-c', command];

    return new Promise<string>((resolve) => {
      execFile(
        shell,
        shellArgs,
        { timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER, encoding: 'utf-8' },
        (error, stdout, stderr) => {
          let output = stdout ?? '';
          if (stderr) output += output ? `\nStd Error:\n${stderr}` : stderr;
          const exitCode = error && typeof error.code === 'number' ? error.code : 0;
          if (exitCode !== 0) output += `\nExit Code: ${exitCode}`;
          resolve(output ? output : '(no output)');
        },
      );
    });
  }

  async readFile(targetPath: string): Promise<string> {
    return fsp.readFile(targetPath, 'utf-8');
  }

  async listDir(targetPath: string, maxDepth = 2): Promise<string[]> {
    return listDir(targetPath, maxDepth);
  }

  async writeFile(targetPath: string, content: string, append = false): Promise<void> {
    const dir = path.dirname(targetPath);
    if (dir) await fsp.mkdir(dir, { recursive: true });
    if (append) await fsp.appendFile(targetPath, content, 'utf-8');
    else await fsp.writeFile(targetPath, content, 'utf-8');
  }

  async glob(targetPath: string, pattern: string, opts: GlobOptions = {}): Promise<GlobResult> {
    return findGlobMatches(targetPath, pattern, {
      includeDirs: opts.includeDirs,
      maxResults: opts.maxResults,
    });
  }

  async grep(targetPath: string, pattern: string, opts: GrepOptions = {}): Promise<GrepResult> {
    return findGrepMatches(targetPath, pattern, {
      globPattern: opts.glob,
      literal: opts.literal,
      caseSensitive: opts.caseSensitive,
      maxResults: opts.maxResults,
    });
  }
}
