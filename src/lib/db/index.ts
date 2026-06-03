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
          updated_at timestamptz not null default now()
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
