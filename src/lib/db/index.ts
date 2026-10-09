import { Pool } from 'pg';
import { ChatSessionType, ChatMessageType } from '@/types';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

// 用 globalThis 在 Next.js dev HMR 下复用同一个 pool，避免每次模块重载都新建连接池
const globalForPg = globalThis as unknown as {
  __pgPool?: Pool;
  __dbInitPromise?: Promise<void>;
};

const pool =
  globalForPg.__pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // 防止某条慢查询拖死整个 pool
    statement_timeout: 15_000,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPg.__pgPool = pool;
}

export const query = async (text: string, params?: any[] | ChatMessageType | ChatSessionType) => {
  const client = await pool.connect();
  let queryParams: any[] = [];

  if (params) {
    if (Array.isArray(params)) {
      queryParams = params;
    } else {
      queryParams = Object.values(params);
    }
  }

  try {
    const result = await client.query(text, queryParams);
    // console.log("query result:", result);
    return result;
  } finally {
    client.release();
  }
};

let checkpointer: PostgresSaver | null = null;
let checkpointerSetupPromise: Promise<void> | null = null;

const globalForCheckpointer = globalThis as unknown as {
  __checkpointer?: PostgresSaver;
  __checkpointerSetupPromise?: Promise<void>;
};

export async function getCheckpointer() {
  if (!checkpointer) {
    checkpointer =
      globalForCheckpointer.__checkpointer ??
      PostgresSaver.fromConnString(process.env.DATABASE_URL!);
    if (process.env.NODE_ENV !== 'production') {
      globalForCheckpointer.__checkpointer = checkpointer;
    }
  }

  if (!checkpointerSetupPromise) {
    checkpointerSetupPromise =
      globalForCheckpointer.__checkpointerSetupPromise ?? checkpointer.setup();
    if (process.env.NODE_ENV !== 'production') {
      globalForCheckpointer.__checkpointerSetupPromise = checkpointerSetupPromise;
    }
  }
  await checkpointerSetupPromise;

  return checkpointer;
}

export const getClient = async () => {
  const client = await pool.connect();
  return client;
};

/**
 * 记忆检索的 pgvector 初始化（与 initialDB 完全独立，原因见函数注释）。
 * 进程级单例挂 globalThis（HMR / 多次 import 只跑一次），按维度缓存：
 * 维度变了重跑一次（列维度同步逻辑处理）。
 */
const globalForMemoryDb = globalThis as unknown as {
  __memoryDbInitPromise?: Promise<MemoryDbInitResult>;
  __memoryDbInitDims?: number;
};

export interface MemoryDbInitResult {
  ok: boolean;
  reason?: string;
}

/**
 * 初始化记忆检索的表：memory_state（jsonb 真相源）+ memory_vectors（pgvector 向量列）。
 *
 * 必须独立于 initialDB、绝不抛出：initialDB 是单条 multi-statement（PG 按一个隐式
 * 事务整体执行），CREATE EXTENSION 若因镜像/权限失败会连带 users 等核心表 bootstrap
 * 全量回滚；这里 own try/catch，任何失败只返回 { ok: false }，由调用方（wiring）
 * 关闭记忆功能（Noop 后端），聊天不阻断。
 *
 * embeddingDimensions 由调用方从 MemoryConfig 取（clamp 后的整数内插进 DDL，无注入面）。
 * 列维度与请求不一致时先 DELETE 再 ALTER TYPE：pgvector 的 vector(m)→vector(n) 强转
 * 会静默截断/补零，先清空让「维度变更存量向量失效、由回填重嵌」的语义与检索侧一致。
 */
export function initialMemoryDb(embeddingDimensions: number): Promise<MemoryDbInitResult> {
  const dims = Math.round(embeddingDimensions);
  if (globalForMemoryDb.__memoryDbInitPromise && globalForMemoryDb.__memoryDbInitDims === dims) {
    return globalForMemoryDb.__memoryDbInitPromise;
  }

  globalForMemoryDb.__memoryDbInitPromise = (async (): Promise<MemoryDbInitResult> => {
    const client = await pool.connect();
    try {
      try {
        await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      } catch (e) {
        return {
          ok: false,
          reason: `CREATE EXTENSION vector 失败: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      await client.query(`
        create table if not exists memory_state (
          scope_key  varchar(255) primary key,
          user_id    varchar(128),
          agent_name varchar(64),
          data       jsonb not null,
          updated_at timestamptz not null default now()
        );

        create table if not exists memory_vectors (
          scope_key varchar(255) not null references memory_state(scope_key) on delete cascade,
          kind      varchar(8)  not null check (kind in ('fact','section')),
          ref_id    varchar(64) not null,
          embedding vector(${dims}) not null,
          primary key (scope_key, kind, ref_id)
        );
        create index if not exists idx_memory_vectors_scope on memory_vectors(scope_key);
      `);

      // 维度同步：pgvector 把维度编码在 pg_attribute.atttypmod（实测 vector(1024) →
      // atttypmod=1024）。带数据 ALTER 会直接报错（"expected N dimensions"）而非静默
      // 截断，但先 DELETE 再 ALTER 与「维度变更存量向量失效、由回填重嵌」语义一致。
      // 查不到视为无从判定，跳过——宁可保留旧列，也不误删存量向量。
      const dimsResult = await client.query(
        `SELECT atttypmod AS dims
         FROM pg_attribute
         WHERE attrelid = 'memory_vectors'::regclass AND attname = 'embedding'`,
      );
      const currentDims = Number(dimsResult.rows[0]?.dims);
      if (Number.isFinite(currentDims) && currentDims !== dims) {
        await client.query(`
          DELETE FROM memory_vectors;
          ALTER TABLE memory_vectors ALTER COLUMN embedding TYPE vector(${dims});
        `);
      }
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        reason: e instanceof Error ? e.message : String(e),
      };
    } finally {
      client.release();
    }
  })();
  globalForMemoryDb.__memoryDbInitDims = dims;
  return globalForMemoryDb.__memoryDbInitPromise;
}

export async function initialDB() {
  // 进程级单例：HMR / 多次 import 都只跑一次
  if (globalForPg.__dbInitPromise) return globalForPg.__dbInitPromise;
  globalForPg.__dbInitPromise = (async () => {
    const client = await pool.connect();
    try {
      // 单条 multi-statement，一次 round-trip 跑完所有 DDL
      await client.query(`
        create table if not exists users (
          id            uuid primary key,
          email         varchar(255) not null unique,
          password_hash text,
          system_role   varchar(20) not null default 'user'
                        check (system_role in ('admin','user')),
          needs_setup   boolean not null default false,
          token_version integer not null default 0,
          created_at    timestamptz not null default now(),
          updated_at    timestamptz not null default now()
        );
        create index if not exists idx_users_email on users(email);
        create index if not exists idx_users_role on users(system_role);
        -- 用户当前选用的模型预设（preset key），跨设备一致；null 表示未选择。
        alter table users add column if not exists selected_model varchar(64);
        -- 记忆注入模式：'inject'（全量注入，默认）| 'retrieve'（按本轮输入检索 top-K）
        alter table users add column if not exists memory_mode varchar(16);
        -- 邮箱验证状态：存量行回落 true（SMTP 验证是新增能力，老账号不追溯补验）
        alter table users add column if not exists email_verified boolean not null default true;

        -- 邮箱令牌（验证邮箱 / 重置密码）：库存 sha256 哈希，单次使用、24h 过期
        create table if not exists email_tokens (
          id         uuid primary key,
          user_id    uuid not null references users(id) on delete cascade,
          purpose    varchar(20) not null check (purpose in ('verify_email','reset_password')),
          token_hash varchar(64) not null,
          expires_at timestamptz not null,
          used_at    timestamptz,
          created_at timestamptz not null default now()
        );
        create index if not exists idx_email_tokens_hash on email_tokens(token_hash);
        create index if not exists idx_email_tokens_user on email_tokens(user_id);

        -- 用户级模型 API Key：按 (user_id, provider) 维度保存，仅存密文/IV/authTag/掩码，
        -- 绝不存明文。一个 provider 的 Key 可服务该 provider 下多个预设模型。
        create table if not exists user_model_keys (
          user_id     uuid not null,
          provider    varchar(32) not null,
          enc_key     text not null,
          iv          text not null,
          auth_tag    text not null,
          key_masked  varchar(64) not null,
          created_at  timestamptz not null default now(),
          updated_at  timestamptz not null default now(),
          primary key (user_id, provider)
        );
        create index if not exists idx_user_model_keys_user on user_model_keys(user_id);

        create table if not exists chat_session (
          id uuid primary key,
          seq_id integer not null,
          title varchar(255) not null,
          created_at timestamp with time zone default current_timestamp,
          updated_at timestamp with time zone default current_timestamp
        );
        alter table chat_session add column if not exists user_id uuid;
        create index if not exists idx_chat_session_user on chat_session(user_id, updated_at desc);

        create table if not exists chat_message (
          id uuid primary key,
          session_id uuid not null references chat_session(id) on delete cascade,
          role varchar(50) not null,
          parts jsonb not null default '[]'::jsonb,
          created_at timestamp with time zone default current_timestamp
        );
        alter table chat_message add column if not exists user_id uuid;
        create index if not exists idx_chat_message_user on chat_message(user_id, created_at);

        create table if not exists file_metadata (
          id uuid primary key,
          message_id uuid not null,
          session_id uuid not null,
          filename varchar(255) not null,
          mime_type varchar(100),
          size_bytes bigint,
          minio_bucket varchar(100) not null,
          minio_key text not null,
          uploaded_at timestamp with time zone default current_timestamp,
          foreign key (message_id) references chat_message(id) on delete cascade
        );

        create table if not exists file_content (
          minio_bucket varchar(100) not null,
          minio_key text not null primary key,
          content text,
          status varchar(20) not null default 'pending'
              check (status in ('pending', 'parsing', 'success', 'failed')),
          error_message text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          user_id uuid not null
        );

        alter table file_content add column if not exists file_id uuid;
        alter table file_content add column if not exists filename varchar(255);
        alter table file_content add column if not exists mime_type varchar(100);
        alter table file_content add column if not exists size_bytes bigint;

        create unique index if not exists file_content_file_id_uidx
          on file_content(file_id) where file_id is not null;
        create index if not exists idx_chat_message_session
          on chat_message(session_id, created_at);
        create index if not exists idx_file_by_message
          on file_metadata(session_id, message_id);
        create index if not exists idx_session_updated
          on chat_session(updated_at desc);

        create table if not exists threads_meta (
          thread_id     uuid primary key,
          assistant_id  varchar(64) not null default 'lead',
          user_id       varchar(128),
          display_name  varchar(255) not null default 'New thread',
          status        varchar(20) not null default 'idle'
                        check (status in ('idle','running','error','interrupted')),
          metadata      jsonb not null default '{}'::jsonb,
          created_at    timestamptz not null default now(),
          updated_at    timestamptz not null default now()
        );
        create index if not exists idx_threads_meta_user on threads_meta(user_id);
        create index if not exists idx_threads_meta_assistant on threads_meta(assistant_id);
        create index if not exists idx_threads_meta_updated on threads_meta(updated_at desc);

        create table if not exists runs (
          run_id        uuid primary key,
          thread_id     uuid not null references threads_meta(thread_id) on delete cascade,
          assistant_id  varchar(64) not null default 'lead',
          user_id       varchar(128),
          status        varchar(20) not null default 'pending'
                        check (status in ('pending','running','succeeded','failed','interrupted')),
          input         jsonb,
          error         text,
          created_at    timestamptz not null default now(),
          updated_at    timestamptz not null default now()
        );
        create index if not exists idx_runs_thread on runs(thread_id);
        create index if not exists idx_runs_status on runs(status);
        create index if not exists idx_runs_created on runs(created_at desc);
      `);
    } catch (error) {
      // 失败时清空 promise，下次还能再试
      globalForPg.__dbInitPromise = undefined;
      console.error('db initialization failed:', error);
      throw error;
    } finally {
      client.release();
    }
  })();

  return globalForPg.__dbInitPromise;
}

export default pool;
