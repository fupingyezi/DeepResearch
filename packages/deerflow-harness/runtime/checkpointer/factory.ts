/**
 * makeCheckpointer —— Checkpointer 工厂
 *
 * - memory：直接 new MemorySaver（来自 @langchain/langgraph 顶层导出）
 * - postgres：代理 lib/db 的 getCheckpointer() 单例，避免重建连接池
 * - sqlite：本期占位，throw not implemented；真正需要时再补 @langchain/langgraph-checkpoint-sqlite
 */

import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { MemorySaver } from '@langchain/langgraph';

import { getCheckpointer as getPgCheckpointer } from '@/lib/db';

export type CheckpointerKind = 'memory' | 'postgres' | 'sqlite';

export interface CheckpointerHandle {
  saver: BaseCheckpointSaver;
  /** 释放 saver 持有的资源（PostgresSaver 走 lib/db 的连接池，无需 close）。 */
  close: () => Promise<void>;
}

export interface MakeCheckpointerOptions {
  kind: CheckpointerKind;
}

const noop = async (): Promise<void> => {};

export async function makeCheckpointer(opts: MakeCheckpointerOptions): Promise<CheckpointerHandle> {
  switch (opts.kind) {
    case 'memory':
      return { saver: new MemorySaver(), close: noop };

    case 'postgres': {
      const saver = await getPgCheckpointer();
      // pg.Pool 的生命周期由 lib/db 统一管理，这里不主动 end。
      return { saver: saver, close: noop };
    }

    case 'sqlite':
      throw new Error(
        '[checkpointer] sqlite backend is not implemented; install @langchain/langgraph-checkpoint-sqlite if needed',
      );

    default: {
      const _exhaustive: never = opts.kind;
      throw new Error(`[checkpointer] unknown kind: ${String(_exhaustive)}`);
    }
  }
}
