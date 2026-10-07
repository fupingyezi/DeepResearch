/**
 * skill —— 按需读取 / 执行「技能（Skill）」资源（渐进披露 L2/L3 通道）。
 *
 * 背景：系统提示只注入 L1（name/description/资源目录），正文与 references/scripts
 * 不进上下文。本工具是模型拉取技能细节的唯一通道：
 * - action=read（默认）：返回 SKILL.md 正文（内存中已解析，免读盘）或指定资源文件
 * - action=run：把 scripts/ 下的脚本复制到沙箱 workspace 执行，返回 stdout；
 *   脚本内容只在降级路径（沙箱不可用 / 被门控 / 执行失败）才回传上下文
 *
 * 安全不变量（宿主读的第一个模型可达面，防护自备）：
 * - 只允许 enabled skill：每调用 loadEnabledSkills() 按名查找，禁用即不存在
 * - resource 只能是相对路径（拒绝绝对路径 / 盘符 / 空段 / . / .. 段 / 目录），
 *   落点经 realpath 双重校验包含在 skill 目录内（防 symlink 逃逸）
 * - run 只认 resources 清单里 kind==='script' 的条目；副本写入走
 *   sandbox.writeFile（docker/remote 后端天然落对位置，不可宿主直接 fs.writeFile），
 *   执行走 sandbox.executeCommand（受后端隔离边界约束），非隔离后端仍受
 *   host-bash 门控——绝不宿主裸跑模型可及内容
 * - 工具级 acquire 是幂等 touch-only，refCount 由 sandbox-middleware 独占维护，
 *   因此本工具不调 release/markIdle（与 7 个沙箱工具同款）
 * - 超时用 Promise.race：executeCommand 不接受 AbortSignal（LocalSandbox 自带
 *   600s 硬超时兜底），race 只放弃等待，底层进程由沙箱自身超时停止
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { tool, type ToolRuntime } from 'langchain';
import z from 'zod';

import type { Skill } from '../../extensions/skills';
import { loadEnabledSkills } from '../../extensions/skills';
import { getSandboxProvider } from '../../sandbox/provider-factory';
import { isWithin, maskLocalPathsInOutput } from '../../sandbox/path-utils';
import { isHostBashAllowed, LOCAL_HOST_BASH_DISABLED_MESSAGE } from '../../sandbox/security';
import {
  ensureSandbox,
  truncateHead,
  truncateMiddle,
  type ResolvedSandboxContext,
} from '../../sandbox/tools';

const READ_MAX_CHARS = 100_000;
const RUN_OUTPUT_MAX_CHARS = 100_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;
const MIN_SCRIPT_TIMEOUT_MS = 100;

const SkillToolSchema = z.object({
  skill: z.string().min(1).describe('技能名（<available_skills> 中列出的名称）。'),
  resource: z
    .string()
    .optional()
    .describe(
      '技能目录下的资源相对路径，如 references/xxx.md、scripts/xxx.py；省略时返回 SKILL.md 正文。',
    ),
  action: z
    .enum(['read', 'run'])
    .optional()
    .describe('read（默认）返回资源内容；run 把 scripts/ 下的脚本复制到沙箱工作区执行并返回输出。'),
  args: z.string().optional().describe('action=run 时追加的命令行参数（按空白切分）。'),
});

function scriptTimeoutMs(): number {
  const raw = Number.parseInt(process.env.DEERFLOW_SKILL_SCRIPT_TIMEOUT_MS ?? '', 10);
  if (!Number.isFinite(raw)) return DEFAULT_SCRIPT_TIMEOUT_MS;
  return Math.max(MIN_SCRIPT_TIMEOUT_MS, raw);
}

export type NormalizeResult = { path: string } | { error: string };

/** 校验并归一 resource 相对路径；非法输入返回中文提示（不抛沙箱异常，模型可读）。 */
export function normalizeResourcePath(resource: string): NormalizeResult {
  if (resource.startsWith('/') || /^[a-zA-Z]:/.test(resource)) {
    return { error: `resource 必须是相对 skill 目录的路径，不能是绝对路径："${resource}"` };
  }
  const normalized = resource.replace(/\\/g, '/');
  if (normalized.endsWith('/')) {
    return { error: `resource 指向目录而非文件："${resource}"` };
  }
  const segments = normalized.split('/');
  if (segments.some((s) => s.length === 0 || s === '.' || s === '..')) {
    return { error: `resource 路径非法（含空段、. 或 .. 段）："${resource}"` };
  }
  return { path: normalized };
}

type ResolveResult = { filePath: string } | { error: string };

/** realpath 双重校验：资源真实路径必须落在 skill 目录真实路径内（防 symlink 逃逸）。 */
async function resolveResourceFile(skill: Skill, resourcePath: string): Promise<ResolveResult> {
  const candidate = path.resolve(skill.dir, resourcePath);
  let realFile: string;
  let realDir: string;
  try {
    [realFile, realDir] = await Promise.all([fsp.realpath(candidate), fsp.realpath(skill.dir)]);
  } catch {
    return { error: `资源不存在或不可读："${resourcePath}"` };
  }
  if (!isWithin(realFile, realDir)) {
    return { error: `资源越界（符号链接指向 skill 目录之外）："${resourcePath}"` };
  }
  return { filePath: realFile };
}

/** read 分支：SKILL.md 用内存中已解析正文（免读盘），资源文件宿主直读。 */
async function readSkillResource(skill: Skill, resource: string | undefined): Promise<string> {
  if (!resource) {
    if (!skill.body.trim()) return '(SKILL.md 正文为空)';
    return truncateHead(skill.body, READ_MAX_CHARS, '本工具不支持分片读取，请按需改用更具体的资源');
  }
  const normalized = normalizeResourcePath(resource);
  if ('error' in normalized) return normalized.error;
  const resolved = await resolveResourceFile(skill, normalized.path);
  if ('error' in resolved) return resolved.error;
  try {
    const content = await fsp.readFile(resolved.filePath, 'utf8');
    if (!content.trim()) return '(empty)';
    return truncateHead(content, READ_MAX_CHARS, '本工具不支持分片读取，请按需改用更具体的资源');
  } catch {
    return `资源读取失败："${resource}"`;
  }
}

/** 由 shebang 推断解释器；未识别时用程序名本身（无 shebang 默认 bash）。 */
export function interpreterFromShebang(content: string): string {
  const firstLine = content.slice(0, 200).split('\n', 1)[0] ?? '';
  if (!firstLine.startsWith('#!')) return 'bash';
  const tokens = firstLine.slice(2).trim().split(/\s+/);
  let program = (tokens[0] ?? '').split('/').pop() ?? '';
  // `#!/usr/bin/env python3`：解释器名是 env 后的第一个参数；env -S 等特殊形态不猜，回落 bash
  if (program === 'env') {
    const arg = tokens[1] ?? '';
    program = arg.startsWith('-') || arg.length === 0 ? 'bash' : (arg.split('/').pop() ?? 'bash');
  }
  if (program === 'python') return 'python3';
  if (program === 'nodejs') return 'node';
  return program || 'bash';
}

/** args 按空白切分后逐 token JSON 引用——含 `;` 等元字符的 token 只是惰性字符串参数。 */
export function quoteArgs(args: string | undefined): string {
  return (args ?? '')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => JSON.stringify(token))
    .join(' ');
}

class SkillScriptTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`skill script timed out after ${ms}ms`);
  }
}

/** race 超时：executeCommand 不接受 AbortSignal，只放弃等待，进程由沙箱硬超时兜底。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SkillScriptTimeoutError(ms)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 降级返回：脚本内容回传上下文，模型可自行阅读或改经沙箱工具手工执行。 */
function degradeWithContent(content: string, reason: string): string {
  return `${reason}\n\n脚本内容如下（可自行阅读，或改经沙箱工具手工执行）：\n\`\`\`\n${content}\n\`\`\``;
}

/** run 分支：脚本复制进沙箱 workspace 执行；任何失败 / 门控 / 超时都降级回传脚本内容。 */
async function runSkillScript(
  skill: Skill,
  resourcePath: string,
  args: string | undefined,
  runtime: ToolRuntime,
): Promise<string> {
  // 只认 resources 清单里的 script 条目（enumerateResources 只走 references/ 与 scripts/）
  const entry = skill.resources.find((r) => r.path === resourcePath);
  if (!entry || entry.kind !== 'script') {
    const scripts = skill.resources.filter((r) => r.kind === 'script').map((r) => r.path);
    return scripts.length > 0
      ? `无法执行："${resourcePath}" 不在该技能的脚本清单中。可用脚本：${scripts.join('、')}`
      : `无法执行："${resourcePath}" 不在该技能的脚本清单中（该技能没有 scripts/ 资源）。`;
  }

  const resolved = await resolveResourceFile(skill, resourcePath);
  if ('error' in resolved) return resolved.error;
  let content: string;
  try {
    content = await fsp.readFile(resolved.filePath, 'utf8');
  } catch {
    return `脚本读取失败："${resourcePath}"`;
  }
  if (!content.trim()) return '(脚本为空，无法执行)';

  // host-bash 门控：非隔离后端（Local 宿主直连）默认禁执行——绝不宿主裸跑模型可及内容
  if (!getSandboxProvider().isSecureIsolation() && !isHostBashAllowed()) {
    return degradeWithContent(content, `脚本执行被禁用：${LOCAL_HOST_BASH_DISABLED_MESSAGE}`);
  }

  let ctx: ResolvedSandboxContext;
  try {
    ctx = await ensureSandbox(runtime);
  } catch (error) {
    return degradeWithContent(content, `沙箱不可用，无法执行脚本：${messageOf(error)}`);
  }
  const { sandbox, threadData } = ctx;
  const workspacePath = threadData.workspacePath;
  if (!workspacePath) {
    return degradeWithContent(content, 'thread workspace 未就绪，无法执行脚本');
  }

  const scriptName = path.basename(resourcePath);
  try {
    // 走 provider 写：docker/remote 后端天然落对位置，不可宿主直接 fs.writeFile
    await sandbox.writeFile(path.join(workspacePath, scriptName), content);
  } catch (error) {
    return degradeWithContent(content, `脚本写入沙箱失败：${messageOf(error)}`);
  }

  const interpreter = interpreterFromShebang(content);
  const quotedArgs = quoteArgs(args);
  const command =
    `cd ${JSON.stringify(workspacePath)} && ${interpreter} ${JSON.stringify(scriptName)}` +
    (quotedArgs ? ` ${quotedArgs}` : '');

  try {
    const output = await withTimeout(sandbox.executeCommand(command), scriptTimeoutMs());
    return truncateMiddle(maskLocalPathsInOutput(output, threadData), RUN_OUTPUT_MAX_CHARS);
  } catch (error) {
    if (error instanceof SkillScriptTimeoutError) {
      return degradeWithContent(
        content,
        `脚本执行超时（${error.ms}ms）：已放弃等待，底层进程由沙箱自身超时（最长 600s）兜底停止`,
      );
    }
    return degradeWithContent(content, `脚本执行失败：${messageOf(error)}`);
  } finally {
    // 尽力清理 workspace 副本（失败静默——遗留文件不影响正确性，只多占磁盘）
    sandbox
      .executeCommand(`rm -f ${JSON.stringify(path.join(workspacePath, scriptName))}`)
      .catch(() => {});
  }
}

export const skillTool = tool(
  async (input, runtime: ToolRuntime) => {
    const { skill: skillName, resource, action, args } = input;

    let skills: Skill[];
    try {
      skills = await loadEnabledSkills();
    } catch {
      return '技能加载失败（扩展配置不可用），请稍后再试。';
    }
    const skill = skills.find((s) => s.name === skillName);
    if (!skill) {
      return skills.length > 0
        ? `未找到已启用的技能 "${skillName}"。可用技能：${skills.map((s) => s.name).join('、')}`
        : `未找到已启用的技能 "${skillName}"（当前没有启用任何技能）。`;
    }

    if (action === 'run') {
      if (!resource) return 'action=run 需要指定 resource（scripts/ 下的脚本相对路径）。';
      const normalized = normalizeResourcePath(resource);
      if ('error' in normalized) return normalized.error;
      return runSkillScript(skill, normalized.path, args, runtime);
    }
    return readSkillResource(skill, resource);
  },
  {
    name: 'skill',
    description:
      '按需读取或执行「技能（Skill）」的资源。系统提示的 <available_skills> 只列出每个技能的名称、' +
      '描述与资源目录（不含正文），因此当任务需要套用某个技能时，先调用本工具拉取其详细说明，' +
      '再按说明执行工作流。参数：skill=技能名；resource=技能目录下的资源相对路径（如 ' +
      'references/xxx.md、scripts/xxx.py，省略时返回 SKILL.md 正文）；action=read（默认）返回' +
      '文件内容，action=run 把 scripts/ 下的脚本复制到沙箱工作区执行并返回 stdout（args 为追加' +
      '的命令行参数）。仅当用户需求与技能用途匹配、且需要技能细节时才调用；不匹配时不要调用。',
    schema: SkillToolSchema,
  },
);
