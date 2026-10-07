#!/usr/bin/env bash
# 增量建库：把笔记库中新增/修改的 markdown 切块、向量化写进 SQLite。
# 按 mtime + sha256 跳过未变文件，重复执行代价很低（首次全量最慢）。
set -euo pipefail

# 示例模板不内置默认路径：使用前必须设置 OBSIDIAN_RAG_DIR（或修改本行换成本机路径）
RAG_DIR="${OBSIDIAN_RAG_DIR:?请设置 OBSIDIAN_RAG_DIR 指向 obsidian-rag 项目目录，或修改本行换成本机路径}"
if [ ! -d "$RAG_DIR" ]; then
  echo "obsidian-rag 项目目录不存在: $RAG_DIR（请设置 OBSIDIAN_RAG_DIR）" >&2
  exit 1
fi

cd "$RAG_DIR"
npm run index
