/**
 * Agent 包装器 - 将 DeerFlowClient 适配为 LangSmith evaluate 兼容的函数
 *
 * 核心职责：
 *   1. 初始化 DeerFlowClient 实例
 *   2. 将 stream 输出聚合为完整文本
 *   3. 收集性能指标（延迟、token 用量）
 *   4. 返回 LangSmith 期望的 { output: string } 格式
 */

import { randomUUID } from 'node:crypto';

import { DeerFlowClient } from '../../src/deerflow-harness/client';
import { runWithContext } from '../../src/deerflow-harness/runtime/context';
import type { ModelConfig } from '../../src/deerflow-harness/types';
import {
  ClientAgentEvent,
  ClientAgentEventType,
} from '../../src/deerflow-harness/runtime/sse/client-event';

export interface AgentRunResult {
  /** Agent 最终输出文本（完整回答） */
  output: string;
  /** 性能指标 */
  metrics: PerformanceMetrics;
  /** 原始事件列表（调试用） */
  events: ClientAgentEvent[];
}

export interface PerformanceMetrics {
  /** Time to First Token (ms) */
  ttftMs: number;
  /** 端到端总延迟 (ms) */
  totalLatencyMs: number;
  /** 工具调用次数 */
  toolCallCount: number;
  /** 工具调用名称列表 */
  toolNames: string[];
  /** 是否出错 */
  error: boolean;
  /** 错误信息 */
  errorMessage?: string;
}

/**
 * 创建包装后的 agent 函数，供 LangSmith evaluate 使用
 *
 * @example
 * ```ts
 * import { createBenchmarkAgent } from './agent';
 *
 * const runAgent = createBenchmarkAgent({ modelName: 'gpt-4o-mini' });
 * const result = await runAgent({ query: '什么是量子计算？' });
 * ```
 */
export function createBenchmarkAgent(options: {
  modelName: string;
  baseUrl?: string;
  apiKey?: string;
  memoryEnabled?: boolean;
}) {
  return async (input: { query: string }): Promise<AgentRunResult> => {
    const startTime = Date.now();

    try {
      // 构建 ModelConfig
      const modelConfig: ModelConfig = {
        modelName: options.modelName,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
      };

      // 创建 DeerFlowClient（保留完整工具能力，与生产一致）
      const client = new DeerFlowClient(modelConfig, {
        memoryEnabled: options.memoryEnabled ?? false,
        autoTitleEnabled: false,
        threadDataEnabled: false,
        uploadsEnabled: false,
        sandboxEnabled: false,
      });

      // 执行 stream 并聚合输出
      let fullText = '';
      let ttftRecorded = false;
      let ttftMs = 0;
      const toolNames: string[] = [];
      const events: ClientAgentEvent[] = [];

      // ⚠️ 关键：每个 benchmark 项目必须用唯一 thread_id 建立 RuntimeContext。
      // LoopDetectionMiddleware 是进程级单例，其 toolFreq 计数器按 thread_id 隔离。
      // 若不建立上下文，subagent 的 getContext()?.thread_id 为 undefined，会全部
      // 落到字符串 'default' 这同一个桶里，导致跨项目累加计数、永不重置——
      // 先跑的项目把计数刷过 hardLimit(50) 后，后续项目的每次工具调用都被秒杀。
      // 这里复刻生产 runtime/service.ts 的 runWithContext 入口，按项目隔离计数器。
      const threadId = randomUUID();
      await runWithContext(
        {
          thread_id: threadId,
          run_id: randomUUID(),
          assistant_id: 'benchmark',
          currentModelConfig: modelConfig,
        },
        async () => {
          for await (const event of client.stream(input.query, threadId)) {
            events.push(event);

            // 记录 TTFT（首个正文 token 到达）
            if (!ttftRecorded && event.eventType === ClientAgentEventType.STREAM_CHUNK) {
              if ((event as any).payload?.text) {
                ttftMs = Date.now() - startTime;
                ttftRecorded = true;
              }
            }

            // 聚合文本内容（仅取最终答案正文，跳过 reasoning）
            if (event.eventType === ClientAgentEventType.STREAM_CHUNK) {
              const text = (event as any).payload?.text;
              if (typeof text === 'string') fullText += text;
            }

            // 统计工具调用
            if (event.eventType === ClientAgentEventType.TOOL_CALL) {
              toolNames.push((event as any).payload?.toolName ?? 'unknown');
            }
          }
        },
      );

      return {
        output: fullText.trim(),
        metrics: {
          ttftMs,
          totalLatencyMs: Date.now() - startTime,
          toolCallCount: toolNames.length,
          toolNames,
          error: false,
        },
        events,
      };
    } catch (error: any) {
      return {
        output: '',
        metrics: {
          ttftMs: 0,
          totalLatencyMs: Date.now() - startTime,
          toolCallCount: 0,
          toolNames: [],
          error: true,
          errorMessage: error?.message ?? String(error),
        },
        events: [],
      };
    }
  };
}
