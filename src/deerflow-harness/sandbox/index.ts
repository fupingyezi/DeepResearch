/**
 * Sandbox Module — deerflow-harness
 *
 * 代码执行沙箱（预留模块）
 *
 * @module deerflow-harness/sandbox
 */

/**
 * 沙箱提供者接口
 *
 * 未来实现时，沙箱将支持在隔离环境中执行代码片段，
 * 并返回执行结果（stdout、stderr、exitCode）。
 */
export interface SandboxProvider {
  /** 沙箱名称 */
  name: string;
  /** 执行代码 */
  execute(code: string, language: string): Promise<SandboxResult>;
}

/** 沙箱执行结果 */
export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
