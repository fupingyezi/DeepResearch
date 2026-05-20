import { Pool } from "pg";
import { ChatSessionType, ChatMessageType } from "@/types";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const query = async (
  text: string,
  params?: any[] | ChatMessageType | ChatSessionType
) => {
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
        id integer not null,
        session_id uuid not null references chat_session(id) on delete cascade,
        role varchar(50) not null,
        content text not null,
        file_count integer default 0,
        accumulated_token_usage integer default 0,
        mode varchar(20) not null default 'chat' check (mode in ('chat', 'search', 'deepResearch')),
        research_status varchar(20) not null default 'failed' check (research_status in ('processing', 'suspended', 'finished', 'failed')),
        created_at timestamp with time zone default current_timestamp,
        primary key (session_id, id)
      );
    `);

    // 3. deep_research_result
    await query(`
      create table if not exists deep_research_result (
        id serial primary key,
        session_id uuid not null,
        message_id integer not null,
        research_target text not null,
        report text,
        created_at timestamp with time zone default current_timestamp,
        updated_at timestamp with time zone default current_timestamp,

        foreign key (session_id, message_id) 
          references chat_message(session_id, id) 
          on delete cascade,

        unique (session_id, message_id)
      );
    `);

    // 4. research_task
    await query(`
      create table if not exists research_task (
        id uuid primary key,
        task_id text not null, 
        research_result_id integer not null references deep_research_result(id) on delete cascade,
        description text not null,
        need_search boolean default false,
        result text,
        created_at timestamp with time zone default current_timestamp,
        updated_at timestamp with time zone default current_timestamp
      );
    `);

    // 5. research_task_search_result
    await query(`
      create table if not exists research_task_search_result (
        id serial primary key,
        task_id uuid not null references research_task(id) on delete cascade,
        title text,
        source_url text,
        content text,
        relative_score numeric(5,4)
      );
    `);

    // 6. file_metadata
    await query(`
      create table if not exists file_metadata (
        id uuid primary key,
        message_id integer not null,
        session_id uuid not null,
        filename varchar(255) not null,
        mime_type varchar(100),
        size_bytes bigint,
        minio_bucket varchar(100) not null,
        minio_key text not null,
        uploaded_at timestamp with time zone default current_timestamp,

        foreign key (session_id, message_id) 
          references chat_message(session_id, id) 
          on delete cascade
      );
    `);

    //7. file_content
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

    await query(
      `create index if not exists idx_chat_message_session on chat_message(session_id);`
    );
    await query(
      `create index if not exists idx_deep_research_by_message on deep_research_result(session_id, message_id);`
    );
    await query(
      `create index if not exists idx_research_task_by_result on research_task(research_result_id);`
    );
    await query(
      `create index if not exists idx_file_by_message on file_metadata(session_id, message_id);`
    );
    await query(
      `create index if not exists idx_session_updated on chat_session(updated_at desc);`
    );

    // 8. threads_meta —— 用户级线程元信息（与 LangGraph checkpoint 解耦）
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
    await query(
      `create index if not exists idx_threads_meta_user on threads_meta(user_id);`
    );
    await query(
      `create index if not exists idx_threads_meta_assistant on threads_meta(assistant_id);`
    );
    await query(
      `create index if not exists idx_threads_meta_updated on threads_meta(updated_at desc);`
    );

    // 9. runs —— 每次执行的运行记录
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
    await query(
      `create index if not exists idx_runs_thread on runs(thread_id);`
    );
    await query(
      `create index if not exists idx_runs_status on runs(status);`
    );
    await query(
      `create index if not exists idx_runs_created on runs(created_at desc);`
    );
  } catch (error) {
    console.error("db initialization failed:", error);
    throw error;
  }
}

export default pool;
