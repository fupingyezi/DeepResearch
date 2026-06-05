/**
 * 文件写操作串行化锁。
 *
 * Node 单进程下，同一 (sandboxId, path) 的并发写可能交错破坏内容。用
 * 「Promise 链」把同 key 的写操作串行化：每次取上一个 tail，挂接自己的执行，
 * 再把 tail 更新为本次的完成 Promise。空闲 key 会在执行后从 Map 清理，避免泄漏。
 */

const locks = new Map<string, Promise<unknown>>();

function lockKey(sandboxId: string, filePath: string): string {
  return `${sandboxId}\u0000${filePath}`;
}

export async function withFileLock<T>(
  sandboxId: string,
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = lockKey(sandboxId, filePath);
  const previous = locks.get(key) ?? Promise.resolve();

  const run = previous.then(fn, fn);
  // tail 仅用于排队，忽略其结果与异常（异常通过 run 抛给调用方）
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );

  try {
    return await run;
  } finally {
    // 若本次是队尾，清理 key，避免长时间运行进程累积空闲锁
    const tail = locks.get(key);
    if (tail) {
      void tail.then(() => {
        if (locks.get(key) === tail) locks.delete(key);
      });
    }
  }
}
