# mini-DeepResearch Benchmark

基于 **LangSmith** 的 Deep Research Agent 质量评估方案。

## 快速开始

### 1. 配置环境变量

```bash
cp benchmarks/.env.example .env.local
# 编辑 .env.local 填入实际 API Key
```

**必须配置：**
| 变量 | 说明 | 来源 |
|------|------|------|
| `LANGCHAIN_TRACING_V2=true` | 启用 LangSmith Tracing | - |
| `LANGCHAIN_API_KEY` | LangSmith API Key | https://smith.langchain.com/settings/keys |
| `DEEPSEEK_API_KEY` | DeepSeek API Key（Agent 默认模型） | https://platform.deepseek.com/ |

**可选配置：**
| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BENCHMARK_AGENT_MODEL` | `deepseek-chat` | 覆盖 Agent 模型 |
| `BENCHMARK_JUDGE_MODEL` | `gpt-4o` | LLM Judge 评估模型 |
| `BENCHMARK_CONCURRENCY` | 2 | 并发数 |
| `BENCHMARK_VERBOSE` | false | 详细日志 |

> **注意**：不设置 `BENCHMARK_AGENT_*` 时，自动使用项目已有的 `DEEPSEEK_BASE_URL` + `DEEPSEEK_API_KEY`，模型默认为 `deepseek-chat`。

### 2. 运行 Benchmark

> **必须从项目根目录执行**

```bash
# 运行全部测试（8条预设数据）
npx tsx benchmarks/run.ts

# 按分类运行
npx tsx benchmarks/run.ts --category single-hop
npx tsx benchmarks/run.ts --category technical-deep-dive

# 运行单条
npx tsx benchmarks/run.ts --id tech-001

# 上传数据集到 LangSmith Dashboard
npx tsx benchmarks/run.ts --upload

# 指定输出路径
npx tsx benchmarks/run.ts --output my-results.json
```

### 3. 查看结果

- **终端输出**：实时显示每条测试的评分和性能指标
- **JSON 报告**：保存在 `benchmarks/results/latest.json`
- **LangSmith Dashboard**：上传后可在 https://smith.langchain.com 查看 trace 详情

## 架构说明

```
benchmarks/
├── tsconfig.bench.json     # 专用 TS 配置（IDE 类型检查用，含 src/）
├── run.ts                  # 主执行脚本
├── config.ts               # 配置管理
├── .env.example            # 环境变量模板
├── datasets/
│   └── research-qa.ts      # 预置测试数据集（8条）
├── evaluators/
│   └── index.ts            # 评估器集合
│       ├── NonEmptyEvaluator      # 非空检查
│       ├── ErrorFreeEvaluator     # 错误率
│       ├── KeywordCoverageEvaluator # 关键词覆盖率
│       ├── PerformanceEvaluator   # 性能指标（TTFT/延迟）
│       └── LlmJudgeEvaluator      # LLM-as-Judge 多维打分
├── agent-wrapper.ts        # DeerFlowClient → LangSmith 适配器
└── README.md               # 本文件
```

## 评估指标说明

| 指标 | 类型 | 分数范围 | 说明 |
|------|------|----------|------|
| `non_empty` | 代码 | 0/1 | 输出是否有效（>50字符） |
| `error_free` | 代码 | 0/1 | 是否无报错 |
| `keyword_coverage` | 代码 | 0-1 | 期望关键词覆盖率 |
| `performance` | 代码 | 0-1 | TTFT + 总延迟综合得分 |
| `llm_judge` | LLM | 0-1 | GPT-4o 多维度打分（准确性/完整性/深度/结构/引用） |

## 自定义数据集

在 `benchmarks/datasets/research-qa.ts` 中扩展 `DATASET_V1` 数组：

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
  run: |
    npx tsx benchmarks/run.ts --output benchmark-results.json
    node scripts/check-benchmark-threshold.js benchmark-results.json
```
