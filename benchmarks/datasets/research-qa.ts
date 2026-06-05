/**
 * 测试数据集 - Deep Research 专用 QA 对
 *
 * 覆盖场景：
 *   1. 单步事实查询
 *   2. 多跳推理（需要多次搜索）
 *   3. 时效性知识（近期事件）
 *   4. 技术深度分析（代码/架构）
 *   5. 综合研究报告（多源整合）
 *
 * 每条数据格式：
 *   {
 *     id: string,
 *     query: string,           // 用户问题
 *     category: string,        // 分类标签
 *     expectedKeywords?: string[], // 期望出现的关键词（用于自动评估）
 *     referenceAnswer?: string,    // 参考答案（可选，用于 LLM-as-Judge）
 *     difficulty: 'easy' | 'medium' | 'hard',
 *   }
 */

export interface BenchmarkExample {
  id: string;
  query: string;
  category: string;
  /** 难度 */
  difficulty: 'easy' | 'medium' | 'hard';
  /** 期望答案中应包含的关键词（用于 AnswerRelevancy 自动检查） */
  expectedKeywords?: string[];
  /** 参考答案（用于 LLM-as-Judge 精确评估） */
  referenceAnswer?: string;
}

/** 预置测试数据集 v1 */
export const DATASET_V1: BenchmarkExample[] = [
  // ── 单步事实查询 (easy) ──
  {
    id: 'fact-001',
    query: '什么是 LangGraph？它和 LangChain 的关系是什么？',
    category: 'single-hop',
    difficulty: 'easy',
    expectedKeywords: ['LangGraph', '状态机', '工作流', '有向图'],
    referenceAnswer:
      'LangGraph 是 LangChain 构建的用于构建有状态、多参与者的应用框架。它基于图结构定义 Agent 的工作流，支持循环、分支、条件边等复杂控制流，是 LangChain 生态中负责编排和运行时执行的核心组件。',
  },
  {
    id: 'fact-002',
    query: 'Next.js 14 的 App Router 和 Pages Router 有什么主要区别？',
    category: 'single-hop',
    difficulty: 'easy',
    expectedKeywords: ['App Router', 'Pages Router', 'Server Components', '文件路由'],
  },

  // ── 多跳推理 (medium) ──
  {
    id: 'multi-001',
    query:
      'RAG（检索增强生成）系统中，如何平衡召回率和精确率？请从索引策略、重排序、混合搜索三个维度分析。',
    category: 'multi-hop',
    difficulty: 'medium',
    expectedKeywords: ['RAG', '召回率', '精确率', '重排序', '向量搜索', '关键词搜索'],
  },
  {
    id: 'multi-002',
    query:
      '对比分析 OpenAI GPT-4o、Anthropic Claude 3.5 Sonnet、Google Gemini 1.5 Pro 三款模型在 Agent 场景下的工具调用能力差异。',
    category: 'multi-hop',
    difficulty: 'medium',
    expectedKeywords: [
      'GPT-4o',
      'Claude',
      'Gemini',
      '工具调用',
      'function calling',
      'JSON Schema',
    ],
  },

  // ── 时效性知识 (medium-hard) ──
  {
    id: 'timeliness-001',
    query: '2025 年 AI Agent 领域最重要的技术突破有哪些？',
    category: 'timeliness',
    difficulty: 'medium',
    expectedKeywords: ['AI Agent', 'LLM', '推理', '工具使用'],
  },
  {
    id: 'timeliness-002',
    query: '当前主流 LLM 应用框架（LangChain/CrewAI/AutoGen）的优缺点对比是什么？',
    category: 'timeliness',
    difficulty: 'hard',
    expectedKeywords: ['LangChain', 'CrewAI', 'AutoGen', '框架对比'],
  },

  // ── 技术深度分析 (hard) ──
  {
    id: 'tech-001',
    query:
      '在 TypeScript/Node.js 后端实现 SSE（Server-Sent Events）流式输出时，如何处理背压、断线重连、以及消息边界问题？给出具体的实现方案。',
    category: 'technical-deep-dive',
    difficulty: 'hard',
    expectedKeywords: ['SSE', '背压', '断线重连', '消息边界', 'ReadableStream', 'Node.js'],
  },
  {
    id: 'tech-002',
    query:
      'PostgreSQL 作为 LLM 应用的 Checkpoint 存储方案，相比 Redis 和纯文件存储有哪些优势和劣势？请结合 LangGraph 的 checkpoint-postgres 实际使用场景分析。',
    category: 'technical-deep-dive',
    difficulty: 'hard',
    expectedKeywords: [
      'PostgreSQL',
      'Checkpoint',
      'LangGraph',
      'Redis',
      'ACID',
      '序列化',
    ],
  },
];

/**
 * 导出为 LangSmith dataset 格式
 * 可直接上传到 LangSmith 或本地 JSONL 文件
 */
export function toLangSmithFormat(examples: BenchmarkExample[]): Array<{
  inputs: { query: string };
  outputs?: { referenceAnswer: string; expectedKeywords: string[] };
}> {
  return examples.map((ex) => ({
    inputs: { query: ex.query },
    outputs: ex.referenceAnswer || ex.expectedKeywords
      ? {
          ...(ex.referenceAnswer && { referenceAnswer: ex.referenceAnswer }),
          ...(ex.expectedKeywords && { expectedKeywords: ex.expectedKeywords }),
        }
      : undefined,
  }));
}

/**
 * 导出为 JSONL 格式（本地存储）
 */
export function toJSONL(examples: BenchmarkExample[], filePath: string): void {
  const fs = require('fs');
  const lines = examples.map((ex) => JSON.stringify(ex)).join('\n');
  fs.writeFileSync(filePath, lines, 'utf-8');
  console.log(`[Dataset] 已写入 ${examples.length} 条数据到 ${filePath}`);
}
