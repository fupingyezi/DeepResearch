# LongMemEval 集成指南

## 概述

[LongMemEval](https://arxiv.org/abs/2410.10813) (ICLR 2025) 是一个用于评估聊天助手**长期记忆能力**的基准测试，包含 **500 个高质量问题**，测试 5 大核心能力：

| 能力 | 说明 | 问题数 |
|------|------|--------|
| **Information Extraction** | 从历史对话中直接提取事实 | 126 |
| **Multi-Session Reasoning** | 跨多个会话推理 | 133 |
| **Temporal Reasoning** | 理解时间顺序和跨度 | 133 |
| **Knowledge Updates** | 处理随时间变化的信息 | 78 |
| **Abstention** | 识别无法回答的问题并拒绝 | 30 |

## 快速开始

### 1. 配置环境变量

```bash
cp benchmarks/.env.example benchmarks/.env.local
# 编辑填入 API Key（至少需要 BENCHMARK_AGENT_API_KEY）
```

### 2. 运行 LongMemEval 基准测试

```bash
# 从项目根目录执行

# 运行全部 500 条问题（S版，~115k tokens 历史）
npx tsx benchmarks/longmem/run.ts

# 或通过 research-qa/run.ts 路由
npx tsx benchmarks/research-qa/run.ts --dataset longmem
```

### 3. 常用参数

```bash
# 按类型过滤运行
npx tsx benchmarks/longmem/run.ts --type multi-session      # 多会话推理 (133条)
npx tsx benchmarks/longmem/run.ts --type temporal-reasoning # 时间推理 (133条)
npx tsx benchmarks/longmem/run.ts --type knowledge-update   # 知识更新 (78条)
npx tsx benchmarks/longmem/run.ts --type abstention         # 弃权识别 (30条)

# 运行单条问题（调试用）
npx tsx benchmarks/longmem/run.ts --id e47becba

# 使用 Oracle 版本（仅包含证据会话，更快）
npx tsx benchmarks/longmem/run.ts --variant oracle

# 限制数量（快速验证）
npx tsx benchmarks/longmem/run.ts --limit 5

# 对照实验：关闭长期记忆系统
npx tsx benchmarks/longmem/run.ts --no-memory

# 切换历史注入模式
npx tsx benchmarks/longmem/run.ts --history-mode system   # 通过 system prompt 注入
npx tsx benchmarks/longmem/run.ts --history-mode none     # 不注入历史（基线）

# 自定义输出路径
npx tsx benchmarks/longmem/run.ts --output results/my-test.json

# 并发控制（默认 2）
npx tsx benchmarks/longmem/run.ts --concurrency 1
```

## 两种评测模式：PREFIX vs INGEST

这是理解本基准的**核心**。同样是「测长期记忆」，两种模式考察的能力完全不同：

| 维度 | **PREFIX**（默认） | **INGEST**（`--ingest`） |
|------|-------------------|-------------------------|
| 历史如何进入模型 | 全部 session 一次性**拼进 prompt** | 逐 session 喂给**记忆系统抽取/落盘** |
| 提问时 | 模型从超长 prompt 里现读现答 | 模型从存储的记忆里**检索**作答（不再带历史） |
| 实际考察 | 长 prompt 阅读理解 | **记忆写入 → 存储 → 跨 session 检索**端到端 |
| 记忆系统是否真正参与 | 否（写入器空跑） | **是** |
| LLM 调用量 | 1 次/题 | 1 次/session（写入）+ 1 次/题（提问），**显著更高** |
| 贴近 LongMemEval 本意 | 部分 | **是** |

```bash
# 默认 PREFIX 模式：把历史拼进 prompt
npx tsx benchmarks/longmem/run.ts --limit 5

# INGEST 两阶段模式：真正测试记忆写入→检索
npx tsx benchmarks/longmem/run.ts --ingest --limit 5
```

### INGEST 模式工作原理

```
阶段 1（写入）：每个 example 用独立 userId 隔离
  haystack_sessions → 逐个 session → MemoryUpdater(LLM 抽取事实/摘要)
                                          ↓
                              users/{userId}/memory.json

阶段 2（检索）：提问时不注入历史
  query → lead-agent (memory=ON, 同一 userId)
              ↓ 自动从 users/{userId}/memory.json 注入记忆
          基于记忆作答 → LLM Judge 判对错
```

要点：
- **隔离**：每题独立 `userId`（`longmem_<question_id>`）→ 独立记忆文件，题目之间互不污染；开跑前会清空该题旧记忆。
- **存储位置**：默认落到 `benchmarks/.memory-store/`（通过 `DEERFLOW_DATA_DIR`），不污染 `~/.deer-flow`，可直接删除清理。
- **串行执行**：INGEST 模式强制 `concurrency=1`，保证写入顺序与日志清晰、规避 LLM 限流。
- **抽取模型**：复用 agent 模型（非流式、低温度），无需额外配置。
- 报告会多出一块 **Memory Ingestion** 指标（平均 session 数 / 抽取出的 fact 数 / 写入耗时）。


## 架构设计

### 文件结构

```
benchmarks/
├── config.ts                         # 配置管理（共享）
├── load-env.ts                       # 环境变量加载（共享）
├── data/
│   ├── longmemeval_s_cleaned.json    # S版: ~115k tokens, ~40 sessions (265MB)
│   └── longmemeval_oracle.json       # Oracle版: 仅证据会话 (15MB)
├── results/
│   └── longmem/                      # 本套件运行结果
├── longmem/
│   ├── run.ts                        # 主执行脚本
│   ├── agent.ts                      # LongMemEval 专用 Agent 包装器
│   ├── ingest.ts                     # 记忆写入阶段（INGEST 模式）
│   ├── dataset.ts                    # 数据集适配器 + 格式转换
│   └── README.md                     # 本文件
└── research-qa/
    └── run.ts                        # 通用入口 (--dataset longmem 路由)
```

### 核心流程

```
LongMemEval JSON → 数据集适配器 → 格式化历史 → Agent (memory=ON) → 收集回答 → 导出 JSONL
                      ↓                                    ↓
              500 条结构化数据                   注入聊天历史上下文
                                                        ↓
                                              测试长期记忆能力：
                                              - 信息提取 ✓
                                              - 多会话推理 ✓
                                              - 时间推理 ✓
                                              - 知识更新 ✓
                                              - 弃权识别 ✓
```

### 关键差异 vs 标准 Benchmark

| 维度 | 标准 Benchmark (`research-qa/run.ts`) | LongMemEval (`longmem/run.ts`) |
|------|--------------------------------------|-------------------------------|
| 输入 | 单个 `query` | `query` + 完整聊天历史 |
| Memory | 默认关闭 | **默认开启** |
| 历史注入 | 无 | prefix / system / none 三种模式 |
| 评估输出 | JSON + 自定义评分器 | JSON + **官方 JSONL 格式** |
| 后续评估 | 内置 LLM Judge | 可选官方 GPT-4o 评估脚本 |

## 结果解读

### 输出文件

1. **JSON 报告** (`benchmarks/results/longmem/latest.json`)
   ```json
   {
     "config": { "memoryEnabled": true, "historyMode": "prefix" },
     "summary": {
       "totalExamples": 500,
       "successCount": 480,
       "avgLatencyMs": 15000,
       "byType": { "multi-session": { "total": 133, "success": 128 } }
     },
     "results": [...]
   }
   ```

2. **JSONL 文件** (`benchmarks/results/longmem/latest.jsonl`)
   - 兼容 [LongMemEval 官方评估脚本](https://github.com/xiaowu0162/LongMemEval)
   - 可用于 GPT-4o Judge 精确评估

### 使用官方 GPT-4o 评估（可选）

```bash
# 克隆官方仓库
git clone https://github.com/xiaowu0162/LongMemEval.git

# 安装依赖
cd LongMemEval
pip install -r requirements-lite.txt

# 运行评估
export OPENAI_API_KEY=your-key
cd src/evaluation
python3 evaluate_qa.py gpt-4o <path/to/hypothesis.jsonl> <path/to/longmemeval_oracle.json>

# 查看指标
python3 print_qa_metrics.py gpt-4o hypothesis.log ../../data/longmemeval_oracle.json
```

## 对照实验建议

为了验证你的**长期记忆系统**的有效性，建议进行以下对照实验：

### 实验 1: Memory ON vs OFF

```bash
# 开启记忆（默认）
npx tsx benchmarks/longmem/run.ts -o results/memory-on.json

# 关闭记忆（对照基线）
npx tsx benchmarks/longmem/run.ts --no-memory -o results/memory-off.json
```

**预期结果**: memory-on 的准确率应显著高于 memory-off，特别是在多会话推理和时间推理类问题上。

### 实验 2: 不同历史注入模式

```bash
# Prefix 模式（推荐）
npx tsx benchmarks/longmem/run.ts --history-mode prefix -o results/prefix.json

# System Prompt 模式
npx tsx benchmarks/longmem/run.ts --history-mode system -o results/system.json

# 无历史注入（纯 QA 能力基线）
npx tsx benchmarks/longmem/run.ts --history-mode none -o results/none.json
```

### 实验 3: 分类型分析

```bash
# 分别运行各类型，观察记忆系统在不同能力上的表现
for type in multi-session temporal-reasoning knowledge-update single-session-user abstention; do
  npx tsx benchmarks/longmem/run.ts --type $type -o results/by-type/$type.json
done
```

## 故障排查

### 问题：`数据集文件不存在`
```bash
# 手动下载数据集
mkdir -p benchmarks/data
cd benchmarks/data
curl -L -o longmemeval_s_cleaned.json "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json"
curl -L -o longmemeval_oracle.json "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json"
```

### 问题：API Key 缺失
确保 `.env.local` 中配置了至少以下变量：
- `BENCHMARK_AGENT_API_KEY` 或 `DEEPSEEK_API_KEY`

### 问题：超时
- 减小并发数：`--concurrency 1`
- 使用 Oracle 版本：`--variant oracle`
- 限制数量先验证：`--limit 10`

## 参考资料

- [LongMemEval 论文 (ICLR 2025)](https://arxiv.org/abs/2410.10813)
- [GitHub 仓库](https://github.com/xiaowu0162/LongMemEval)
- [项目主页](https://xiaowu0162.github.io/publications/13_longmemeval/)
