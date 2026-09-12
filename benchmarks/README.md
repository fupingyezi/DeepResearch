# 基准测试与评估框架

`benchmarks/` 内置两套离线评估套件，用于量化 Agent 的研究质量与长期记忆能力。
两套件共用 `config.ts`（模型 / 评分 / 并发配置）与 `load-env.ts`（环境变量加载）。

## 环境准备

```bash
cp benchmarks/.env.example benchmarks/.env.local
# 填入 judge 的 key 与 baseUrl（见下）。LangSmith 可选。
```

环境变量加载顺序（`load-env.ts`，后者只在前者没设该变量时生效）：

```
benchmarks/.env.local  >  根 .env.local  >  根 .env
```

根 `.env` 兜底意味着**产品开发环境已有的 `DEEPSEEK_*` / `TAVILY_API_KEY` 会被自动继承**，
通常只需要额外补 judge 的三项。

### 必填与可选

| 变量                       | 必填性                        | 说明                                                                       |
| -------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| `BENCHMARK_JUDGE_API_KEY`  | **必填**（除非 `--no-judge`） | judge 侧**没有** `DEEPSEEK_*` 回落，缺了直接报错退出                       |
| `BENCHMARK_JUDGE_BASE_URL` | **必填**（除非 `--no-judge`） | 同上不回落到 `DEEPSEEK_BASE_URL`；漏配会把请求带着 key 打到 api.openai.com |
| `BENCHMARK_JUDGE_MODEL`    | 可选                          | 默认 `deepseek-v4-pro`                                                     |
| `BENCHMARK_AGENT_MODEL`    | 可选                          | 默认 `deepseek-flash`                                                      |
| `LANGCHAIN_API_KEY` 等     | 可选                          | 缺失只告警；仅 `--upload` 与在 LangSmith UI 看 trace 需要                  |

`validateEnv()` 对**必填项缺失是硬失败**（抛错 + 非零退出），不再静默降级。这修的是两个
静默失真：judge key 缺失时 research-qa 会**悄悄不创建 LLM judge**（报告仍打印 judge 模型名）、
longmem 会**悄悄改用 agent 模型自评**；judge baseUrl 缺失时请求打到 OpenAI，judge 全部失败
并被记成 0 分平均进结果。想显式不评分请加 `--no-judge`，把「静默降级」变成「显式选择」。

## 套件一览

| 套件           | 目的                                       | 入口                 | 数据集位置                       |
| -------------- | ------------------------------------------ | -------------------- | -------------------------------- |
| `research-qa/` | 研究 QA 质量打分（Agent 输出 vs 参考答案） | `research-qa/run.ts` | `research-qa/dataset.ts`（内置） |
| `longmem/`     | LongMemEval 长期记忆基准（ICLR 2025）      | `longmem/run.ts`     | `benchmarks/data/`（需手动下载） |

## 运行

```bash
# 研究 QA 评估
pnpm bench:qa
pnpm bench:qa -- --id tech-001        # 单条

# LongMemEval：两阶段（先 --ingest 预写记忆，再评测）
pnpm bench:longmem:ingest
pnpm bench:longmem

# 显式跳过评分（不产出 accuracy / llm_judge，也不要求 judge 配置）
pnpm bench:qa -- --no-judge
```

LongMemEval 数据集需手动下载（官方 HuggingFace 源），详见
[`longmem/README.md`](./longmem/README.md)「数据准备」一节。

## token 用量与成本

报告（`benchmarks/results/**/latest.json` 与终端）会给出按角色拆分的 token 与费用：

- **token 是实测值**：agent 侧经模型工厂的 callback 累加（含 subagent、中间件与记忆抽取
  的调用），judge 侧就地读取响应的 `usage_metadata`。实现在
  `src/deerflow-harness/runtime/usage-accounting.ts`。
- **金额是估算**：单价取自 `src/deerflow-harness/runtime/pricing.json`（含 `asOf` 与官方
  URL）。价格变动只改这个文件，不动代码。**未知模型不给估算**，只列进 `unknownModels`。
- **按角色拆分**：`agent`（作答）/ `judge`（评分）/ `ingest`（LongMemEval 的
  `--ingest` 记忆写入，成本大头）/ `memory`（记忆更新抽取）。`memory` 单独成角色是因为
  它跑在 agent run 之外 —— `afterAgent` 只入队，真正的调用由 debounce 队列稍后触发，
  并发批次下会落到每轮 run 的记账窗口之外。评测会在出报告前统一兜底 flush；实测不兜底
  时 5 次抽取只有 1 次被计入，**报告成本漏掉约 60%**（且 `callsMissingUsage` 抓不到 ——
  那些调用完全没进作用域）。
- **记忆更新会失败，报告里看得到**：报告 summary 有 `memoryUpdates: {attempted, succeeded,
failed}`。失败的形态是**静默丢事实** —— 记忆抽取的输出顶到 `maxTokens` 时，响应可能为空
  或 JSON 被截断，解析失败即跳过本次更新（不影响 accuracy 分母，却会让「记忆模式」成绩
  无理由偏低）。实测 8192 时 10 次里失败 4 次，故记忆模型的 `maxTokens` 已提到 **16384**；
  若报告里 `failed > 0`，终端会醒目告警。
- 计价区分三个维度：缓存命中 vs 未命中（单价可差 50 倍）、高峰 vs 空闲（空闲恰为高峰半价，
  高峰 = 北京时间周一~周五 09:00-12:00 / 14:00-18:00，按**每次调用自己的时刻**判定）、
  reasoning token 计入输出。
- 报告里有 `callsMissingUsage` / `callsCoarseUsage` 两个「记账缺口」计数：前者表示有调用
  拿不到 usage（成本被低估），后者表示只有粗粒度 usage（缓存命中体现不出，成本被高估）。
  终端在缺口 > 0 时会打 `⚠️ 记账缺口` 一行 —— 看到它就别把金额当准数。
- 已知盲区：LangChain 内层的 HTTP 重试对记账不可见（自建网关可能对每次重试都计费），
  这部分费用不会体现在报告里。
- 逐次调用记录（含各自的时间戳）随条目落盘，因此价格表或时段规则变化后，
  **可以直接从历史报告重算费用**，不必重跑评测。

省钱的两个杠杆：把便宜档放在 agent 侧（体积大的一侧），以及尽量让 run 落在**空闲时段**
（北京工作日 12:00-14:00、18:00 之后与周末，单价减半；报告里的 `ifAllPeakTotal` 是全落在
高峰时段的上界，可用于对照）。

## TTFT 与流式分片的口径（容易误读）

agent 的正文**不是无条件逐 token 下发的**：`client.ts` 有一个「报告范式」分类器
（`looksLikeFinalReportStart`，见 `src/deerflow-harness/client.ts`）—— 仅当回答以
Markdown 标题（`# ` / `## ` / `### `）或摘要引用块（`> **`）开头时，才判定为「最终报告
正文」并逐 token 流式下发；否则内容会被缓冲到本轮结束、整段一次性刷出。设计意图是把
「工具调用前的规划叙述」与「最终报告正文」分开，前者归到 reasoning 通道。

对评测的含义：

- **TTFT 只在报告式回答上等于「首 token 时间」**。会话式短答（LongMemEval 里「X 是什么」
  这类一两句话的回答）几乎都是整体刷出，此时 **TTFT ≈ 总延迟** —— 别拿它当流式性能指标，
  更不要用它比较不同模型的首字延迟。
- 报告里的 `eventTypes.stream_chunk` 同样受此影响，不适合当作「流式流畅度」的度量。
  同一模型下，`你好` 这类寒暄只会有 1 个分片，而 report 式回答会有几百到几千个。
- 要比较真实流式表现，请用**会产出报告式回答**的题目（如 research-qa 的
  technical-deep-dive），并同时看 `performance` 评估器给出的 TTFT 与总延迟。

## 目录结构

```
benchmarks/
├── config.ts             # 统一配置（模型 / 评分 / 并发，读 .env）
├── load-env.ts           # .env 加载（benchmarks/.env.local > 根 .env.local > 根 .env）
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
