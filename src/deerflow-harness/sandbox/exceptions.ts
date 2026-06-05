/**
 * Sandbox 错误体系：用自定义错误类承载结构化信息（path / command / code 等），
 */

export class SandboxError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SandboxError';
    this.details = details ?? {};
  }
}

/** 找不到指定 sandbox（已被释放或 id 非法）。 */
export class SandboxNotFoundError extends SandboxError {
  readonly sandboxId?: string;

  constructor(message = 'Sandbox not found', sandboxId?: string) {
    super(message, sandboxId ? { sandboxId } : undefined);
    this.name = 'SandboxNotFoundError';
    this.sandboxId = sandboxId;
  }
}

/** sandbox 运行时不可用 / 配置缺失（如缺 thread_data、缺 thread_id）。 */
export class SandboxRuntimeError extends SandboxError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = 'SandboxRuntimeError';
  }
}

/** 文件操作越权 / 路径穿越被拒。 */
export class SandboxPermissionError extends SandboxError {
  readonly path?: string;

  constructor(message: string, path?: string) {
    super(message, path ? { path } : undefined);
    this.name = 'SandboxPermissionError';
    this.path = path;
  }
}

/** 目标文件/目录不存在。 */
export class SandboxFileNotFoundError extends SandboxError {
  readonly path?: string;

  constructor(message: string, path?: string) {
    super(message, path ? { path } : undefined);
    this.name = 'SandboxFileNotFoundError';
    this.path = path;
  }
}
