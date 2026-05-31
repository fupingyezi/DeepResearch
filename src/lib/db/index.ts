import { Pool } from 'pg';
import { ChatSessionType, ChatMessageType } from '@/types';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

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
let isSetup = false;

export async function getCheckpointer() {
  if (!checkpointer) {
    checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
  }

  if (!isSetup) {
    await checkpointer.setup();
    isSetup = true;
  }

  return checkpointer;
}

export const getClient = async () => {
  const client = await pool.connect();
  return client;
};

export async function initialDB() {
  try {
    // 1. chat_session
    await query(`
      create table if not exists chat_session (
        id uuid primary key,
        seq_id integer not null,
        title varchar(255) not null,
        created_at timestamp with time zone default current_timestamp,
        updated_at timestamp with time zone default current_timestamp
      );
    `);

    // 2. chat_message
    await query(`
      create table if not exists chat_message (
        id uuid primary key,
        session_id uuid not null references chat_session(id) on delete cascade,
        role varchar(50) not null,
        parts jsonb not null default '[]'::jsonb,
        created_at timestamp with time zone default current_timestamp
      );
    `);

    // 3. file_metadata
    //    message_id 同步为 uuid 外键，对齐 chat_message.id 单列主键。
    await query(`
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
    `);

    // 4. file_content
    await query(`
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
    `);

    // 4.1 file_content 扩展列：用于按 fileId 反查（chat 路由把 message.contents 中
    // 的 file/image block 解析为完整元信息再落 file_metadata）。
    // 已存在的 row 默认 NULL，不影响旧数据。
    await query(`alter table file_content add column if not exists file_id uuid;`);
    await query(`alter table file_content add column if not exists filename varchar(255);`);
    await query(`alter table file_content add column if not exists mime_type varchar(100);`);
    await query(`alter table file_content add column if not exists size_bytes bigint;`);
    await query(
      `create unique index if not exists file_content_file_id_uidx on file_content(file_id) where file_id is not null;`,
    );

    await query(
      `create index if not exists idx_chat_message_session on chat_message(session_id, created_at);`,
    );
    await query(
      `create index if not exists idx_file_by_message on file_metadata(session_id, message_id);`,
    );
    await query(`create index if not exists idx_session_updated on chat_session(updated_at desc);`);

    // 5. threads_meta —— 用户级线程元信息（与 LangGraph checkpoint 解耦）
    await query(`
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
    `);
    await query(`create index if not exists idx_threads_meta_user on threads_meta(user_id);`);
    await query(
      `create index if not exists idx_threads_meta_assistant on threads_meta(assistant_id);`,
    );
    await query(
      `create index if not exists idx_threads_meta_updated on threads_meta(updated_at desc);`,
    );

    // 6. runs —— 每次执行的运行记录
    await query(`
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
    `);
    await query(`create index if not exists idx_runs_thread on runs(thread_id);`);
    await query(`create index if not exists idx_runs_status on runs(status);`);
    await query(`create index if not exists idx_runs_created on runs(created_at desc);`);
  } catch (error) {
    console.error('db initialization failed:', error);
    throw error;
  }
}

export default pool;
