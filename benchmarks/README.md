# 基准测试与评估框架

`benchmarks/` 内置两套离线评估套件，用于量化 Agent 的研究质量与长期记忆能力。
两套件共用 `config.ts`（模型 / 评分 / 并发配置）与 `load-env.ts`（环境变量加载）。

## 环境准备

```bash
cp benchmarks/.env.example benchmarks/.env.local
# 编辑填入 LANGCHAIN_API_KEY（必填，LangSmith 追踪）与模型 API Key
```

评分模型与 LangSmith 为必填项：`config.ts` 在缺失时直接报错退出，避免产出无法追溯的结果。

## 套件一览

| 套件           | 目的                                       | 入口                 | 数据集位置                       |
| -------------- | ------------------------------------------ | -------------------- | -------------------------------- |
| `research-qa/` | 研究 QA 质量打分（Agent 输出 vs 参考答案） | `research-qa/run.ts` | `research-qa/dataset.ts`（内置） |
| `longmem/`     | LongMemEval 长期记忆基准（ICLR 2025）      | `longmem/run.ts`     | `benchmarks/data/`（需手动下载） |

## 运行

```bash
# 研究 QA 评估
npx tsx benchmarks/research-qa/run.ts

# LongMemEval：两阶段（先 --ingest 预写记忆，再评测）
npx tsx benchmarks/longmem/run.ts --ingest
npx tsx benchmarks/longmem/run.ts
```

LongMemEval 数据集需手动下载（官方 HuggingFace 源），详见
[`longmem/README.md`](./longmem/README.md)「数据准备」一节。

## 目录结构

```
benchmarks/
├── config.ts             # 统一配置（模型 / 评分 / 并发，读 .env）
├── load-env.ts           # .env 加载（根目录 + benchmarks/）
├── tsconfig.bench.json   # benchmarks 独立 tsconfig
├── longmem/              # LongMemEval 套件
│   ├── README.md         # 详细说明（数据准备 / 两阶段模式 / 分类型运行）
│   ├── run.ts            # 评测主脚本（CLI 参数：--ingest / --type / --limit / --history-mode ...）
│   ├── agent.ts          # Agent 包装器（PREFIX / INGEST 两种历史模式）
│   ├── dataset.ts        # 官方数据集格式适配
│   └── ingest.ts         # 记忆预写入（逐 session 落盘 memory.json，按题隔离 userId）
└── research-qa/          # 研究 QA 套件
    ├── README.md         # 详细说明
    ├── run.ts            # 评测主脚本
    ├── agent.ts          # Agent 包装器
    ├── dataset.ts        # 研究 QA 数据集
    └── evaluators.ts     # 质量评分器
```

## 与产品代码的关系

- LongMemEval 的 INGEST 模式直接调用产品记忆链路的 `updateMemoryFromConversation`，
  因此评测结果同时反映产品记忆系统的真实表现。
- 评测脚本不参与 CI（不设 `pnpm test` 门禁）；PR 门禁只跑 `src/**/*.test.ts` 单测。
