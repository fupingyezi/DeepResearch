/**
 * Sandbox 抽象基类：定义沙箱环境的统一能力契约（命令执行 + 文件读写 + 检索）。
 *
 * 当前仅有 LocalSandbox 一种实现（宿主文件系统）；保留抽象是为将来扩展容器隔离
 * 沙箱（如 Docker）时接口稳定。所有路径均为「已解析的宿主真实路径」——虚拟路径
 * (/mnt/user-data) 的映射与安全校验在工具层（path-utils + tools）完成。
 */

export interface GrepMatch {
  path: string;
  lineNumber: number;
  line: string;
}

export interface GlobOptions {
  includeDirs?: boolean;
  maxResults?: number;
}

export interface GrepOptions {
  glob?: string | null;
  literal?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
}

export interface GlobResult {
  matches: string[];
  truncated: boolean;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
}

export abstract class Sandbox {
  constructor(readonly id: string) {}

  /** 执行 bash 命令，返回 stdout/stderr 合并文本。 */
  abstract executeCommand(command: string): Promise<string>;

  /** 读取文本文件全文。 */
  abstract readFile(path: string): Promise<string>;

  /** 树形列出目录内容（默认 2 层）。 */
  abstract listDir(path: string, maxDepth?: number): Promise<string[]>;

  /** 写入文本文件（append=false 时覆盖/新建）。 */
  abstract writeFile(path: string, content: string, append?: boolean): Promise<void>;

  /** 在目录下按 glob 模式查找路径。 */
  abstract glob(path: string, pattern: string, opts?: GlobOptions): Promise<GlobResult>;

  /** 在目录下按正则/字面量检索文本文件内容。 */
  abstract grep(path: string, pattern: string, opts?: GrepOptions): Promise<GrepResult>;
}
