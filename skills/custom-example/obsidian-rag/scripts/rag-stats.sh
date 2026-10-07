#!/usr/bin/env bash
# 索引统计：已索引文件数 / 片段数 / 更新时间，用于判断索引新旧（是否需要先 index）。
set -euo pipefail

# 示例模板不内置默认路径：使用前必须设置 OBSIDIAN_RAG_DIR（或修改本行换成本机路径）
RAG_DIR="${OBSIDIAN_RAG_DIR:?请设置 OBSIDIAN_RAG_DIR 指向 obsidian-rag 项目目录，或修改本行换成本机路径}"
if [ ! -d "$RAG_DIR" ]; then
  echo "obsidian-rag 项目目录不存在: $RAG_DIR（请设置 OBSIDIAN_RAG_DIR）" >&2
  exit 1
fi

cd "$RAG_DIR"
npm run stats
