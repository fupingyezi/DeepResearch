/**
 * 评估器集合 - 用于评估 Agent 输出质量
 *
 * 包含两种类型：
 *   1. 代码评估器（确定性指标）：关键词覆盖率、非空检查、延迟阈值
 *   2. LLM-as-Judge：用强模型对输出打分
 */

import { ChatOpenAI } from '@langchain/openai';
import type { AgentRunResult } from './agent';

// ── 类型定义 ──

export interface EvaluationResult {
  key: string;
  score: number; // 0-1 或 0-10
  comment?: string;
  metadata?: Record<string, unknown>;
}

export interface EvaluatorInput {
  /** 用户原始输入 */
  input: { query: string };
  /** Agent 运行结果 */
  prediction: AgentRunResult;
  /** 参考答案（来自 dataset） */
  referenceOutput?: { referenceAnswer: string; expectedKeywords: string[] };
}

// ══════════════════════════════════════════
//  代码评估器（确定性、无需 LLM）
// ══════════════════════════════════════════

/**
 * 关键词覆盖率评估器
 * 检查 Agent 输出是否包含期望的关键词
 */
export class KeywordCoverageEvaluator {
  readonly name = 'keyword_coverage';

  async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
    const keywords =
      input.referenceOutput?.expectedKeywords ?? [];
    if (keywords.length === 0) {
      return { key: this.name, score: 1, comment: '无期望关键词配置，默认满分' };
    }

    const text = input.prediction.output.toLowerCase();
    let matchedCount = 0;

    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) matchedCount++;
    }

    const score = matchedCount / keywords.length;
    return {
      key: this.name,
      score: Math.round(score * 100) / 100,
      comment: `覆盖 ${matchedCount}/${keywords.length} 个关键词: [${keywords.join(', ')}]`,
      metadata: { matched: matchedCount, total: keywords.length, keywords },
    };
  }
}

/**
 * 非空响应评估器
 * 检查 Agent 是否返回了有效内容
 */
export class NonEmptyEvaluator {
  readonly name = 'non_empty';

  async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
    const text = input.prediction.output;
    const hasContent = typeof text === 'string' && text.trim().length > 50; // 至少50字符

    return {
      key: this.name,
      score: hasContent ? 1 : 0,
      comment: hasContent
        ? `输出长度 ${text.length} 字符`
        : `输出过短或为空 (${text.length} 字符)`,
    };
  }
}

/**
 * 错误率评估器
 * 检查 Agent 是否报错
 */
export class ErrorFreeEvaluator {
  readonly name = 'error_free';

  async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
    const { error, errorMessage } = input.prediction.metrics;
    return {
      key: this.name,
      score: error ? 0 : 1,
      comment: error ? `错误: ${errorMessage}` : '无错误',
    };
  }
}

/**
 * 性能评估器
 * 评估 TTFT 和总延迟是否在合理范围
 */
export class PerformanceEvaluator {
  readonly name = 'performance';

  constructor(private thresholds = { ttftMs: 10000, totalMs: 120000 }) {}

  async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
    const { ttftMs, totalLatencyMs } = input.prediction.metrics;

    // TTFT 得分 (0-1): <3s=1, >10s=0
    const ttftScore = Math.max(
      0,
      Math.min(1, 1 - (ttftMs - 3000) / (this.thresholds.ttftMs - 3000)),
    );

    // 总延迟得分 (0-1): <30s=1, >120s=0
    const latencyScore = Math.max(
      0,
      Math.min(1, 1 - (totalLatencyMs - 30000) / (this.thresholds.totalMs - 30000)),
    );

    const combinedScore = (ttftScore + latencyScore) / 2;
    return {
      key: this.name,
      score: Math.round(combinedScore * 100) / 100,
      comment: `TTFT=${(ttftMs / 1000).toFixed(1)}s, Total=${(totalLatencyMs / 1000).toFixed(1)}s`,
      metadata: { ttftMs, totalLatencyMs, ttftScore, latencyScore },
    };
  }
}

// ══════════════════════════════════════════
//  LLM-as-Judge 评估器
// ══════════════════════════════════════════

const DEFAULT_JUDGE_PROMPT = `你是一个专业的 AI 回答质量评审员。请根据用户问题和 AI 的回答，按以下维度评分（每项 0-10 分）：

## 评分维度

### 1. 准确性 (Accuracy)
- 回答中的事实是否正确？
- 是否有幻觉或错误信息？

### 2. 完整性 (Completeness)
- 是否充分回答了问题的所有方面？
- 是否遗漏了重要细节？

### 3. 深度与洞察 (Depth & Insight)
- 分析是否有深度而非表面化？
- 是否提供了独到见解或综合多个角度？

### 4. 结构与可读性 (Structure & Readability)
- 回答组织是否清晰（标题、段落、列表）？
- 语言表达是否专业且易于理解？

### 5. 引用与证据 (Citations & Evidence)
- 是否引用了可靠的信息来源？
- 论点是否有据可依？（如有参考答案则对照参考）

## 输出格式（严格 JSON）：
{
  "accuracy": <0-10>,
  "completeness": <0-10>,
  "depth": <0-10>,
  "structure": <0-10>,
  "citations": <0-10>,
  "overall": <0-10>,
  "reasoning": "一句话总结评分理由"
}`;

/**
 * LLM-as-Judge 评估器
 * 用强模型对 Agent 输出做多维度打分
 */
export class LlmJudgeEvaluator {
  readonly name = 'llm_judge';

  private model: ChatOpenAI;

  constructor(judgeOptions: {
    modelName: string;
    baseUrl?: string;
    apiKey?: string;
    temperature?: number;
  }) {
    this.model = new ChatOpenAI({
      model: judgeOptions.modelName,
      apiKey: judgeOptions.apiKey ?? process.env.BENCHMARK_JUDGE_API_KEY,
      configuration: judgeOptions.baseUrl
        ? { baseURL: judgeOptions.baseUrl }
        : undefined,
      temperature: judgeOptions.temperature ?? 0,
    });
  }

  async evaluate(input: EvaluatorInput): Promise<EvaluationResult> {
    const userPrompt = `## 用户问题\n${input.input.query}\n\n## AI 回答\n${input.prediction.output || '(无输出)'}\n${
      input.referenceOutput?.referenceAnswer
        ? `\n## 参考答案（供参考）\n${input.referenceOutput.referenceAnswer}`
        : ''
    }`;

    try {
      const response = await this.model.invoke([
        { role: 'system', content: DEFAULT_JUDGE_PROMPT },
        { role: 'user', content: userPrompt },
      ]);

      const rawText = response.content as string;
      // 尝试解析 JSON
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('无法从 Judge 输出中解析 JSON');
      }

      const scores = JSON.parse(jsonMatch[0]);
      const overall = scores.overall ?? scores.accuracy ?? 0;
      const normalizedScore = overall / 10; // 转换为 0-1

      return {
        key: this.name,
        score: Math.round(normalizedScore * 100) / 100,
        comment: scores.reasoning ?? `${overall}/10`,
        metadata: {
          accuracy: scores.accuracy,
          completeness: scores.completeness,
          depth: scores.depth,
          structure: scores.structure,
          citations: scores.citations,
          overall,
        },
      };
    } catch (e: any) {
      return {
        key: this.name,
        score: 0,
        comment: `LLM Judge 评估失败: ${e.message}`,
        metadata: { error: e.message },
      };
    }
  }
}

// ── 便捷工厂函数 ──

export type BuiltInEvaluator =
  | KeywordCoverageEvaluator
  | NonEmptyEvaluator
  | ErrorFreeEvaluator
  | PerformanceEvaluator
  | LlmJudgeEvaluator;

/**
 * 创建默认评估器集合
 */
export function createDefaultEvaluators(
  judgeOptions?: ConstructorParameters<typeof LlmJudgeEvaluator>[0],
): BuiltInEvaluator[] {
  const evaluators: BuiltInEvaluator[] = [
    new NonEmptyEvaluator(),
    new ErrorFreeEvaluator(),
    new KeywordCoverageEvaluator(),
    new PerformanceEvaluator(),
  ];

  if (judgeOptions) {
    evaluators.push(new LlmJudgeEvaluator(judgeOptions));
  }

  return evaluators;
}
