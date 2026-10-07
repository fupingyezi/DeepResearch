---
name: obsidian-rag
description: Use this skill when the user's question is about their personal Obsidian notes or local knowledge base — triggers like "我笔记里记过什么", "查一下我的笔记", "my notes about X", "根据我的笔记", "我记得之前写过...". Queries the local obsidian-rag RAG pipeline (hybrid retrieval + rerank + LLM answer with citations as 文件:行号) and returns cited answers. Do NOT use for general knowledge or web research — only for content in the user's own notes.
---

# Obsidian RAG Skill

## Overview

This skill answers questions about the user's **personal Obsidian vault** through the local `obsidian-rag` pipeline: markdown notes chunked by heading → embedded into SQLite (sqlite-vec + FTS5) → hybrid recall + RRF + rerank → LLM answer with citations. Answers are grounded strictly in the notes: if the notes don't cover something, the pipeline says so instead of fabricating.

## When to Use This Skill

Use when the question is about content the user has **written in their notes** — knowledge base lookup, not web research:

- "我笔记里关于 Redis 持久化记过什么？"
- "查一下我的笔记里对 AOF 的记载"
- "According to my notes, what did I write about X?"
- "我记得之前写过...帮我找一下"

Do NOT use for: general knowledge questions, current events, web research (use the `deep-research` skill instead), or anything not expected to be in the user's own vault.

## Workflow

### 1. Refresh the index first

Run `scripts/rag-index.sh` before the first query in a conversation (or when the user mentions they just edited/added notes). Indexing is incremental — files unchanged by mtime + sha256 are skipped — so repeated runs are cheap.

Skip re-indexing for follow-up questions in the same conversation.

### 2. Ask

Run `scripts/rag-ask.sh` with the question:

```
skill(action="run", resource="scripts/rag-ask.sh", args="<question>")
```

The output contains the answer plus citations in `文件:行号` form. Pass them through to the user — the citations are the point of the local KB.

Optional args appended after the question: `-k <n>` (chunks handed to the generator, default 5), `-t 标签1,标签2` (only chunks carrying all given tags). Use `-t` when the user scopes the question ("关于数据库的笔记").

### 3. Service lifecycle (MCP)

The app also exposes this pipeline as the `obsidian-rag` MCP server (HTTP, 127.0.0.1:3333). Its tools are loaded **once, at the start of each conversation** — a service started mid-conversation only becomes available as MCP tools in _subsequent_ conversations. See `references/mcp-integration.md` for the full timing model.

- Start the service: `scripts/rag-serve.sh` (idempotent — no-op if already healthy). Do this when the conversation will involve multiple KB queries, so later conversations get the MCP tools directly.
- Stop it after the KB work is done: `scripts/rag-kill.sh` (frees the port and any idle resources).

The direct `rag-ask.sh` path works regardless of service state — the MCP layer is a convenience, never a requirement.

## Scripts

| Script                 | Purpose                                                 | Args                                              |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `scripts/rag-index.sh` | Incremental index build (mtime+sha256 skip)             | —                                                 |
| `scripts/rag-ask.sh`   | One-shot question → cited answer                        | `<question>` plus optional `-k <n>` / `-t <tags>` |
| `scripts/rag-serve.sh` | Start HTTP MCP service detached, wait for health (≤30s) | —                                                 |
| `scripts/rag-kill.sh`  | Stop the service (pidfile + port fallback)              | —                                                 |
| `scripts/rag-stats.sh` | Index stats (files/chunks) — check index freshness      | —                                                 |

## Notes

- Scripts run in the app's sandbox with cwd = a per-thread workspace; each script `cd`s to the obsidian-rag project dir itself. This example template ships **no default path** — set `OBSIDIAN_RAG_DIR` (or edit the scripts) before use.
- `rag-ask.sh` calls an LLM and may exceed the skill tool's default 60s timeout — the app should run with `DEERFLOW_SKILL_SCRIPT_TIMEOUT_MS=120000` (or higher) for reliable answers.
- Host bash must be enabled (`DEERFLOW_ALLOW_HOST_BASH=1`); otherwise `action="run"` degrades to returning the script content without executing.
- If the query result says the notes don't cover the topic, report that honestly — do not answer from general knowledge and attribute it to the notes.
