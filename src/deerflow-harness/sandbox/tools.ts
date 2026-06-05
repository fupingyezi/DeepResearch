/**
 * Sandbox 工具集（7 个标准 LangChain 工具）：bash / ls / glob / grep / read_file /
 * write_file / str_replace。对模型暴露虚拟路径 /mnt/user-data，底层经 path-utils
 * 映射到 thread 真实目录并做安全校验，输出做宿主路径脱敏。
 *
 * 惰性初始化：subagent 不经过 SandboxMiddleware（其 createBaseAgent 不传 features），
 * 故工具内部自行从 runtime.state / runtime.config / AsyncLocalStorage 解析 threadId、
 * 获取沙箱、按需创建 thread 目录——保证 lead 与 subagent 都能直接使用。
 */

import * as fsp from 'node:fs/promises';
import { tool, type ToolRuntime } from 'langchain';
import z from 'zod';

import type { SandboxState, ThreadDataState } from '../agents/thread-state';
import { getContext } from '../runtime/context';
import { SandboxError, SandboxRuntimeError } from './exceptions';
import { withFileLock } from './file-operation-lock';
import { getThreadDirectories } from './paths';
import {
  maskLocalPathsInOutput,
  replaceVirtualPathsInCommand,
  resolveAndValidateUserDataPath,
  validateBashCommandPaths,
  validateLocalToolPath,
} from './path-utils';
import { LOCAL_HOST_BASH_DISABLED_MESSAGE, isHostBashAllowed } from './security';
import type { Sandbox } from './sandbox';
import { SandboxFsError } from './search';
import { getSandboxProvider } from './local/local-sandbox-provider';

interface SandboxRuntimeState {
  threadData?: ThreadDataState | null;
  sandbox?: SandboxState | null;
}

interface ResolvedSandboxContext {
  sandbox: Sandbox;
  threadData: ThreadDataState;
}

const BASH_OUTPUT_MAX_CHARS = 20000;
const READ_FILE_OUTPUT_MAX_CHARS = 50000;
const LS_OUTPUT_MAX_CHARS = 20000;
const DEFAULT_GLOB_MAX_RESULTS = 200;
const MAX_GLOB_MAX_RESULTS = 1000;
const DEFAULT_GREP_MAX_RESULTS = 100;
const MAX_GREP_MAX_RESULTS = 500;

const ReadFileSchema = z.object({
  description: z.string().min(1).describe('简述为何读取此文件。请第一个提供该参数。'),
  path: z.string().min(1).describe('要读取文件的绝对路径（如 /mnt/user-data/workspace/a.txt）。'),
  start_line: z.number().int().positive().optional().describe('可选：起始行号（1 起，含）。'),
  end_line: z.number().int().positive().optional().describe('可选：结束行号（1 起，含）。'),
});

const WriteFileSchema = z.object({
  description: z.string().min(1).describe('简述为何写入此文件。请第一个提供该参数。'),
  path: z.string().min(1).describe('要写入文件的绝对路径。请第二个提供该参数。'),
  content: z.string().describe('写入的文本内容。请第三个提供该参数。'),
  append: z.boolean().optional().describe('是否追加；false（默认）则新建/覆盖。'),
});

const StrReplaceSchema = z.object({
  description: z.string().min(1).describe('简述为何替换。请第一个提供该参数。'),
  path: z.string().min(1).describe('目标文件绝对路径。请第二个提供该参数。'),
  old_str: z.string().describe('要替换的子串。请第三个提供该参数。'),
  new_str: z.string().describe('替换后的子串。请第四个提供该参数。'),
  replace_all: z
    .boolean()
    .optional()
    .describe('是否替换全部；false（默认）仅替换第一处且要求唯一。'),
});

const LsSchema = z.object({
  description: z.string().min(1).describe('简述为何列目录。请第一个提供该参数。'),
  path: z.string().min(1).describe('要列出目录的绝对路径。'),
});

const GlobSchema = z.object({
  description: z.string().min(1).describe('简述为何查找。请第一个提供该参数。'),
  pattern: z.string().min(1).describe('相对 path 的 glob 模式，如 `**/*.ts`。'),
  path: z.string().min(1).describe('查找的根目录绝对路径。'),
  include_dirs: z.boolean().optional().describe('是否包含匹配的目录。默认 false。'),
  max_results: z.number().int().positive().optional().describe('返回路径数上限。默认 200。'),
});

const GrepSchema = z.object({
  description: z.string().min(1).describe('简述为何检索内容。请第一个提供该参数。'),
  pattern: z.string().min(1).describe('要检索的字符串或正则。'),
  path: z.string().min(1).describe('检索的根目录绝对路径。'),
  glob: z.string().optional().describe('可选：候选文件的 glob 过滤，如 `**/*.ts`。'),
  literal: z.boolean().optional().describe('是否将 pattern 视为纯字符串。默认 false。'),
  case_sensitive: z.boolean().optional().describe('是否区分大小写。默认 false。'),
  max_results: z.number().int().positive().optional().describe('返回匹配行数上限。默认 100。'),
});

const BashSchema = z.object({
  description: z.string().min(1).describe('简述为何执行该命令。请第一个提供该参数。'),
  command: z.string().min(1).describe('要执行的 bash 命令。文件/目录请使用绝对路径。'),
});

function clampMaxResults(value: number | undefined, fallback: number, upperBound: number): number {
  if (value === undefined || value <= 0) return fallback;
  return Math.min(value, upperBound);
}

function resolveThreadId(runtime: ToolRuntime): string | null {
  const config = runtime.config as { configurable?: { thread_id?: unknown } } | undefined;
  const fromConfig = config?.configurable?.thread_id;
  if (typeof fromConfig === 'string' && fromConfig.length > 0) return fromConfig;
  const fromContext = getContext()?.thread_id;
  return fromContext && fromContext.length > 0 ? fromContext : null;
}

/** 解析本次工具调用的 threadData（含真实目录路径）：优先 state，缺失时按 threadId 推导。 */
function resolveThreadData(runtime: ToolRuntime): ThreadDataState {
  // runtime.state 为外部注入的图状态，单层断言读取（project.md §2.2 外部边界例外）。
  const state = (runtime.state ?? {}) as SandboxRuntimeState;
  const fromState = state.threadData;
  if (fromState && fromState.workspacePath) return fromState;

  const threadId = resolveThreadId(runtime);
  if (!threadId) {
    throw new SandboxRuntimeError('Thread ID not available in runtime for sandbox tool');
  }
  const dirs = getThreadDirectories(threadId);
  return {
    workspacePath: dirs.workspace,
    uploadsPath: dirs.uploads,
    outputsPath: dirs.outputs,
  };
}

async function ensureThreadDirectories(threadData: ThreadDataState): Promise<void> {
  for (const dir of [threadData.workspacePath, threadData.uploadsPath, threadData.outputsPath]) {
    if (dir) await fsp.mkdir(dir, { recursive: true });
  }
}

/** 惰性获取沙箱 + 解析 threadData + 创建 thread 目录。 */
async function ensureSandbox(runtime: ToolRuntime): Promise<ResolvedSandboxContext> {
  const threadData = resolveThreadData(runtime);
  await ensureThreadDirectories(threadData);
  const provider = getSandboxProvider();
  const sandboxId = provider.acquire(resolveThreadId(runtime) ?? undefined);
  const sandbox = provider.get(sandboxId);
  if (sandbox === null) {
    throw new SandboxRuntimeError('Failed to acquire sandbox', { sandboxId });
  }
  return { sandbox, threadData };
}

function truncateMiddle(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  const marker = `\n... [middle truncated: ${output.length} chars skipped] ...\n`;
  const kept = Math.max(0, maxChars - marker.length);
  if (kept === 0) return output.slice(0, maxChars);
  const headLen = Math.floor(kept / 2);
  const tailLen = kept - headLen;
  return `${output.slice(0, headLen)}${marker}${tailLen > 0 ? output.slice(-tailLen) : ''}`;
}

function truncateHead(output: string, maxChars: number, hint: string): string {
  if (output.length <= maxChars) return output;
  const marker = `\n... [truncated: ${output.length} chars total. ${hint}] ...`;
  const kept = Math.max(0, maxChars - marker.length);
  if (kept === 0) return output.slice(0, maxChars);
  return `${output.slice(0, kept)}${marker}`;
}

function formatGlobResults(rootPath: string, matches: string[], truncated: boolean): string {
  if (matches.length === 0) return `No files matched under ${rootPath}`;
  const lines = [
    truncated
      ? `Found ${matches.length} paths under ${rootPath} (showing first ${matches.length})`
      : `Found ${matches.length} paths under ${rootPath}`,
  ];
  matches.forEach((p, index) => lines.push(`${index + 1}. ${p}`));
  if (truncated) lines.push('Results truncated. Narrow the path or pattern.');
  return lines.join('\n');
}

function formatGrepResults(
  rootPath: string,
  matches: Array<{ path: string; lineNumber: number; line: string }>,
  truncated: boolean,
): string {
  if (matches.length === 0) return `No matches found under ${rootPath}`;
  const lines = [
    truncated
      ? `Found ${matches.length} matches under ${rootPath} (showing first ${matches.length})`
      : `Found ${matches.length} matches under ${rootPath}`,
  ];
  matches.forEach((m) => lines.push(`${m.path}:${m.lineNumber}: ${m.line}`));
  if (truncated) lines.push('Results truncated. Narrow the path or add a glob filter.');
  return lines.join('\n');
}

function fsErrorMessage(error: SandboxFsError, requestedPath: string): string {
  if (error.code === 'ENOENT') return `Error: Directory not found: ${requestedPath}`;
  if (error.code === 'ENOTDIR') return `Error: Path is not a directory: ${requestedPath}`;
  return `Error: ${error.message}`;
}

export const readFileTool = tool(
  async (input, runtime: ToolRuntime) => {
    const { path: requestedPath, start_line, end_line } = input;
    try {
      const { sandbox, threadData } = await ensureSandbox(runtime);
      validateLocalToolPath(requestedPath, threadData);
      const realPath = resolveAndValidateUserDataPath(requestedPath, threadData);
      let content = await sandbox.readFile(realPath);
      if (!content) return '(empty)';
      if (start_line !== undefined && end_line !== undefined) {
        content = content
          .split('\n')
          .slice(start_line - 1, end_line)
          .join('\n');
      }
      return truncateHead(
        maskLocalPathsInOutput(content, threadData),
        READ_FILE_OUTPUT_MAX_CHARS,
        'Use start_line/end_line to read a specific range',
      );
    } catch (error) {
      return toToolError(error, `reading file: ${requestedPath}`);
    }
  },
  {
    name: 'read_file',
    description:
      'Read the contents of a text file under /mnt/user-data. Use it to examine source code, ' +
      'configs, logs, or any text-based file you created.',
    schema: ReadFileSchema,
  },
);

export const writeFileTool = tool(
  async (input, runtime: ToolRuntime) => {
    const { path: requestedPath, content, append } = input;
    try {
      const { sandbox, threadData } = await ensureSandbox(runtime);
      validateLocalToolPath(requestedPath, threadData);
      const realPath = resolveAndValidateUserDataPath(requestedPath, threadData);
      await withFileLock(sandbox.id, realPath, () => sandbox.writeFile(realPath, content, append));
      return 'OK';
    } catch (error) {
      return toToolError(error, `writing file: ${requestedPath}`);
    }
  },
  {
    name: 'write_file',
    description:
      'Write text content to a file under /mnt/user-data (creates parent directories as needed). ' +
      'Set append=true to append instead of overwrite.',
    schema: WriteFileSchema,
  },
);

export const strReplaceTool = tool(
  async (input, runtime: ToolRuntime) => {
    const { path: requestedPath, old_str, new_str, replace_all } = input;
    try {
      const { sandbox, threadData } = await ensureSandbox(runtime);
      validateLocalToolPath(requestedPath, threadData);
      const realPath = resolveAndValidateUserDataPath(requestedPath, threadData);
      return await withFileLock(sandbox.id, realPath, async () => {
        const content = await sandbox.readFile(realPath);
        if (!content) return 'OK';
        if (!content.includes(old_str)) {
          return `Error: String to replace not found in file: ${requestedPath}`;
        }
        const next = replace_all
          ? content.split(old_str).join(new_str)
          : content.replace(old_str, new_str);
        await sandbox.writeFile(realPath, next);
        return 'OK';
      });
    } catch (error) {
      return toToolError(error, `replacing string in: ${requestedPath}`);
    }
  },
  {
    name: 'str_replace',
    description:
      'Replace a substring in a file under /mnt/user-data. With replace_all=false (default) the ' +
      'target substring must appear exactly once.',
    schema: StrReplaceSchema,
  },
);

export const lsTool = tool(
  async (input, runtime: ToolRuntime) => {
    const { path: requestedPath } = input;
    try {
      const { sandbox, threadData } = await ensureSandbox(runtime);
      validateLocalToolPath(requestedPath, threadData);
      const realPath = resolveAndValidateUserDataPath(requestedPath, threadData);
      const children = await sandbox.listDir(realPath);
      if (children.length === 0) return '(empty)';
      return truncateHead(
        maskLocalPathsInOutput(children.join('\n'), threadData),
        LS_OUTPUT_MAX_CHARS,
        'Use a more specific path to see fewer results',
      );
    } catch (error) {
      return toToolError(error, `listing directory: ${requestedPath}`);
    }
  },
  {
    name: 'ls',
    description:
      'List the contents of a directory under /mnt/user-data up to 2 levels deep in tree format.',
    schema: LsSchema,
  },
);

export const globTool = tool(
  async (input, runtime: ToolRuntime) => {
    const { pattern, path: requestedPath, include_dirs, max_results } = input;
    try {
      const { sandbox, threadData } = await ensureSandbox(runtime);
      validateLocalToolPath(requestedPath, threadData);
      const realPath = resolveAndValidateUserDataPath(requestedPath, threadData);
      const { matches, truncated } = await sandbox.glob(realPath, pattern, {
        includeDirs: include_dirs,
        maxResults: clampMaxResults(max_results, DEFAULT_GLOB_MAX_RESULTS, MAX_GLOB_MAX_RESULTS),
      });
      const masked = matches.map((m) => maskLocalPathsInOutput(m, threadData));
      return formatGlobResults(requestedPath, masked, truncated);
    } catch (error) {
      if (error instanceof SandboxFsError) return fsErrorMessage(error, requestedPath);
      return toToolError(error, `searching paths under: ${requestedPath}`);
    }
  },
  {
    name: 'glob',
    description:
      'Find files or directories matching a glob pattern under a directory in /mnt/user-data, ' +
      'for example `**/*.ts`.',
    schema: GlobSchema,
  },
);

export const grepTool = tool(
  async (input, runtime: ToolRuntime) => {
    const { pattern, path: requestedPath, glob, literal, case_sensitive, max_results } = input;
    try {
      const { sandbox, threadData } = await ensureSandbox(runtime);
      validateLocalToolPath(requestedPath, threadData);
      const realPath = resolveAndValidateUserDataPath(requestedPath, threadData);
      const { matches, truncated } = await sandbox.grep(realPath, pattern, {
        glob: glob ?? null,
        literal,
        caseSensitive: case_sensitive,
        maxResults: clampMaxResults(max_results, DEFAULT_GREP_MAX_RESULTS, MAX_GREP_MAX_RESULTS),
      });
      const masked = matches.map((m) => ({
        path: maskLocalPathsInOutput(m.path, threadData),
        lineNumber: m.lineNumber,
        line: m.line,
      }));
      return formatGrepResults(requestedPath, masked, truncated);
    } catch (error) {
      if (error instanceof SandboxFsError) return fsErrorMessage(error, requestedPath);
      return toToolError(error, `searching file contents under: ${requestedPath}`);
    }
  },
  {
    name: 'grep',
    description:
      'Search for matching lines inside text files under a directory in /mnt/user-data. Supports ' +
      'regex (default) or literal matching.',
    schema: GrepSchema,
  },
);

export const bashTool = tool(
  async (input, runtime: ToolRuntime) => {
    const { command } = input;
    try {
      if (!isHostBashAllowed()) {
        return `Error: ${LOCAL_HOST_BASH_DISABLED_MESSAGE}`;
      }
      const { sandbox, threadData } = await ensureSandbox(runtime);
      validateBashCommandPaths(command, threadData);
      const resolvedCommand = replaceVirtualPathsInCommand(command, threadData);
      const finalCommand = threadData.workspacePath
        ? `cd ${JSON.stringify(threadData.workspacePath)} && ${resolvedCommand}`
        : resolvedCommand;
      const output = await sandbox.executeCommand(finalCommand);
      return truncateMiddle(maskLocalPathsInOutput(output, threadData), BASH_OUTPUT_MAX_CHARS);
    } catch (error) {
      return toToolError(error, 'executing command');
    }
  },
  {
    name: 'bash',
    description:
      'Execute a bash command in a Linux-like environment. Use `python` to run Python code. ' +
      'Always use absolute paths under /mnt/user-data. Disabled by default for safety.',
    schema: BashSchema,
  },
);

export const SANDBOX_TOOLS = [
  bashTool,
  lsTool,
  globTool,
  grepTool,
  readFileTool,
  writeFileTool,
  strReplaceTool,
];

function toToolError(error: unknown, action: string): string {
  if (error instanceof SandboxError) return `Error: ${error.message}`;
  if (error instanceof SandboxFsError) return `Error: ${error.message}`;
  const nodeError = error as { code?: string };
  if (nodeError?.code === 'ENOENT') return `Error: Not found while ${action}`;
  if (nodeError?.code === 'EISDIR') return `Error: Path is a directory while ${action}`;
  const message = error instanceof Error ? error.message : String(error);
  return `Error: Unexpected error while ${action}: ${message}`;
}
