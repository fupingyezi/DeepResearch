/**
 * makeCheckpointer —— Checkpointer 工厂
 *
 * - memory：直接 new MemorySaver（来自 @langchain/langgraph 顶层导出）
 * - postgres：由宿主注入 pg 连接池或连接串（池生命周期归宿主，本工厂只建 saver；
 *   `setup()` 幂等建表，可重复调用）
 * - sqlite：本期占位，throw not implemented；真正需要时再补 @langchain/langgraph-checkpoint-sqlite
 */

import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { MemorySaver } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Pool } from 'pg';

export type CheckpointerKind = 'memory' | 'postgres' | 'sqlite';

export interface CheckpointerHandle {
  saver: BaseCheckpointSaver;
  /** 释放 saver 持有的资源（PG 连接池归宿主管理，无需 close）。 */
  close: () => Promise<void>;
}

export interface PostgresCheckpointerOptions {
  /** 复用宿主的 pg 连接池（优先于 connectionString）。 */
  pool?: Pool;
  /** 无池时按连接串自建（PostgresSaver.fromConnString 内部建池）。 */
  connectionString?: string;
}

export interface MakeCheckpointerOptions {
  kind: CheckpointerKind;
  postgres?: PostgresCheckpointerOptions;
}

const noop = async (): Promise<void> => {};

export async function makeCheckpointer(opts: MakeCheckpointerOptions): Promise<CheckpointerHandle> {
  switch (opts.kind) {
    case 'memory':
      return { saver: new MemorySaver(), close: noop };

    case 'postgres': {
      const pg = opts.postgres;
      if (!pg || (!pg.pool && !pg.connectionString)) {
        throw new Error(
          '[checkpointer] postgres requires postgres.pool or postgres.connectionString',
        );
      }
      const saver = pg.pool
        ? new PostgresSaver(pg.pool)
        : PostgresSaver.fromConnString(pg.connectionString!);
      await saver.setup();
      // pg.Pool 生命周期由宿主管理，这里不主动 end。
      return { saver, close: noop };
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
