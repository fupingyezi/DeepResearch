# mini-DeepResearch Benchmark (research-qa)

基于 **LangSmith** 的 Deep Research Agent 质量评估方案。

## 快速开始

### 1. 配置环境变量

```bash
cp benchmarks/.env.example .env.local
# 编辑 .env.local 填入实际 API Key
```

**必须配置（缺失时 `validateEnv()` 直接报错退出，不再静默降级）：**
| 变量 | 说明 | 来源 |
|------|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（Agent 模型；也可用 `BENCHMARK_AGENT_API_KEY` 单独给） | https://platform.deepseek.com/ |
| `BENCHMARK_JUDGE_API_KEY` | LLM Judge 的 Key —— judge 侧**没有** `DEEPSEEK_*` 回落，必须显式给（可与 agent 共用同一把） | - |
| `BENCHMARK_JUDGE_BASE_URL` | LLM Judge 的端点 —— 同样无回落，漏配会把请求打到 api.openai.com | DeepSeek 填 `https://api.deepseek.com/v1` |

**可选配置：**
| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BENCHMARK_AGENT_MODEL` | `deepseek-flash` | 覆盖 Agent 模型（官方名） |
| `BENCHMARK_JUDGE_MODEL` | `deepseek-v4-pro` | LLM Judge 评估模型 |
| `BENCHMARK_CONCURRENCY` | 2 | 并发数 |
| `BENCHMARK_TIMEOUT_MS` | 300000 | 单次 run / judge 调用超时，超限记 `errorKind: 'timeout'` |
| `BENCHMARK_VERBOSE` | false | 详细日志 |
| `LANGCHAIN_TRACING_V2=true` + `LANGCHAIN_API_KEY` | - | 可选：启用 LangSmith Tracing（缺失只告警） |

> **注意**：不设置 `BENCHMARK_AGENT_*` 时，自动使用项目已有的 `DEEPSEEK_BASE_URL` + `DEEPSEEK_API_KEY`。
> 根 `.env` 也会被加载（优先级最低），所以产品开发环境的 key 通常已被继承。

### 2. 运行 Benchmark

> **必须从项目根目录执行**

```bash
# 运行全部测试（8条预设数据）
pnpm bench:qa

# 按分类运行
pnpm bench:qa -- --category single-hop
pnpm bench:qa -- --category technical-deep-dive

# 运行单条
pnpm bench:qa -- --id tech-001

# 显式跳过 LLM judge（不产出 llm_judge 指标，也不要求 judge 配置）
pnpm bench:qa -- --no-judge

# 上传数据集到 LangSmith Dashboard
pnpm bench:qa -- --upload

# 指定输出路径
pnpm bench:qa -- --output my-results.json
```

> 报告在**每批结束后增量落盘**，中途失败不会丢掉已完成的部分。

### 3. 查看结果

- **终端输出**：实时显示每条测试的评分和性能指标
- **JSON 报告**：保存在 `benchmarks/results/research-qa/latest.json`
- **LangSmith Dashboard**：上传后可在 https://smith.langchain.com 查看 trace 详情

## 架构说明

```
benchmarks/
├── config.ts                   # 配置管理（共享）
├── load-env.ts                 # 环境变量加载（共享）
├── tsconfig.bench.json         # 专用 TS 配置（IDE 类型检查用，含 src/）
├── .env.example                # 环境变量模板（共享）
├── results/
│   └── research-qa/            # 本套件运行结果
└── research-qa/
    ├── run.ts                  # 主执行脚本
    ├── agent.ts                # DeerFlowClient → LangSmith 适配器
    ├── dataset.ts              # 预置测试数据集（8条）
    ├── evaluators.ts           # 评估器集合
    │   ├── NonEmptyEvaluator      # 非空检查
    │   ├── ErrorFreeEvaluator     # 错误率
    │   ├── KeywordCoverageEvaluator # 关键词覆盖率
    │   ├── PerformanceEvaluator   # 性能指标（TTFT/延迟）
    │   └── LlmJudgeEvaluator      # LLM-as-Judge 多维打分
    └── README.md               # 本文件
```

## 评估指标说明

| 指标               | 类型 | 分数范围 | 说明                                                 |
| ------------------ | ---- | -------- | ---------------------------------------------------- |
| `non_empty`        | 代码 | 0/1      | 输出是否有效（>50字符）                              |
| `error_free`       | 代码 | 0/1      | 是否无报错                                           |
| `keyword_coverage` | 代码 | 0-1      | 期望关键词覆盖率                                     |
| `performance`      | 代码 | 0-1      | TTFT + 总延迟综合得分                                |
| `llm_judge`        | LLM  | 0-1      | Judge 模型多维度打分（准确性/完整性/深度/结构/引用） |

## 自定义数据集

在 `benchmarks/research-qa/dataset.ts` 中扩展 `DATASET_V1` 数组：

```typescript
{
  id: 'custom-001',
  query: '你的问题？',
  category: 'custom-category',
  difficulty: 'medium',
  expectedKeywords: ['期望', '关键词'],
  referenceAnswer: '参考答案（可选）...',
}
```

## 与 LangSmith 集成进阶

### 在 LangSmith UI 中查看

1. 运行 `--upload` 上传数据集
2. 访问 https://smith.langchain.com
3. 选择项目 `mini-deepresearch-benchmark`
4. 在 Datasets 页面查看已上传的测试用例
5. 点击 "Compare" 可对比不同版本的 Agent 输出

### CI/CD 集成示例

```yaml
# .github/workflows/benchmark.yml
- name: Run Benchmark
  env:
    LANGCHAIN_TRACING_V2: true
    LANGCHAIN_API_KEY: ${{ secrets.LANGCHAIN_API_KEY }}
    DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
    # judge 侧无 DEEPSEEK_* 回落，必须显式给（否则 validateEnv 直接中止）
    BENCHMARK_JUDGE_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
    BENCHMARK_JUDGE_BASE_URL: https://api.deepseek.com/v1
  run: |
    pnpm bench:qa -- --output benchmark-results.json
    node scripts/check-benchmark-threshold.js benchmark-results.json
```
