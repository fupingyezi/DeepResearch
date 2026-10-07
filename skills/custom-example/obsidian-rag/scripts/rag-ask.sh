#!/usr/bin/env bash
# 一次性提问：混合检索 + 重排 + LLM 生成带出处的回答（文件:行号），进程随回答结束自行退出。
# 用法：rag-ask.sh <问题> [-k 片段数] [-t 标签1,标签2]
# 注意：内含 LLM 生成，可能超过 skill 工具的默认 60s 超时（见 SKILL.md Notes）。
set -euo pipefail

# 示例模板不内置默认路径：使用前必须设置 OBSIDIAN_RAG_DIR（或修改本行换成本机路径）
RAG_DIR="${OBSIDIAN_RAG_DIR:?请设置 OBSIDIAN_RAG_DIR 指向 obsidian-rag 项目目录，或修改本行换成本机路径}"
if [ ! -d "$RAG_DIR" ]; then
  echo "obsidian-rag 项目目录不存在: $RAG_DIR（请设置 OBSIDIAN_RAG_DIR）" >&2
  exit 1
fi
if [ "$#" -eq 0 ]; then
  echo "用法: rag-ask.sh <问题> [-k 片段数] [-t 标签1,标签2]" >&2
  exit 1
fi

cd "$RAG_DIR"
npm run ask -- "$@"
