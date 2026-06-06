/**
 * LongMemEval 专用 Agent 包装器
 *
 * 与标准 research-qa agent 的关键差异：
 *   1. 支持注入聊天历史 (formattedHistory) 模拟长期记忆上下文
 *   2. 默认开启 memoryEnabled（测试长期记忆系统的核心能力）
 *   3. 将历史信息拼接到用户消息前，模拟真实多轮对话场景
 *
 * 使用方式：
 * ```ts
 * const runAgent = createLongMemAgent({ modelName: 'deepseek-chat' });
 * const result = await runAgent({
 *   query: 'What degree did I graduate with?',
 *   formattedHistory: '=== Session 1 ===\nUser: ...',
 * });
 * ```
 */

import { randomUUID } from 'node:crypto';

import { DeerFlowClient } from '../../src/deerflow-harness/client';
import { runWithContext } from '../../src/deerflow-harness/runtime/context';
import type { ModelConfig } from '../../src/deerflow-harness/types';
import {
  ClientAgentEvent,
  ClientAgentEventType,
} from '../../src/deerflow-harness/runtime/sse/client-event';

export interface LongMemAgentResult {
  /** Agent 最终输出文本 */
  output: string;
  /** 性能指标 */
  metrics: PerformanceMetrics;
  /** 原始事件列表 */
  events: ClientAgentEvent[];
}

export interface PerformanceMetrics {
  /** Time to First Token (ms) */
  ttftMs: number;
  /** 端到端总延迟 (ms) */
  totalLatencyMs: number;
  /** 工具调用次数 */
  toolCallCount: number;
  /** 是否出错 */
  error: boolean;
  /** 错误信息 */
  errorMessage?: string;
}

/**
 * 创建 LongMemEval 专用 agent 函数
 *
 * @param options - 模型和运行配置
 * @returns 异步执行函数，接收 { query, formattedHistory? }
 */
export function createLongMemAgent(options: {
  modelName: string;
  baseUrl?: string;
  apiKey?: string;
  /** 是否开启长期记忆系统（默认 true） */
  memoryEnabled?: boolean;
  /** 历史注入模式：'prefix' | 'system' | 'none' */
  historyMode?: 'prefix' | 'system' | 'none';
  /** 是否启用 web search 工具（默认 false，测试纯记忆能力） */
  webSearchEnabled?: boolean;
}) {
  const memoryEnabled = options.memoryEnabled ?? true;
  const historyMode = options.historyMode ?? 'prefix';
  const webSearchEnabled = options.webSearchEnabled ?? false;

  return async (input: {
    query: string;
    formattedHistory?: string;
    /**
     * 隔离用 userId。设置后 lead-agent 会从 users/{userId}/memory.json 读取并
     * 注入长期记忆——这是 two-phase（--ingest）模式下「记忆检索作答」的关键。
     */
    userId?: string;
  }): Promise<LongMemAgentResult> => {
    const startTime = Date.now();

    try {
      const modelConfig: ModelConfig = {
        modelName: options.modelName,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
      };

      // 创建 DeerFlowClient，开启 memory 测试长期记忆能力
      const client = new DeerFlowClient(modelConfig, {
        memoryEnabled,
        autoTitleEnabled: false,
        threadDataEnabled: false,
        uploadsEnabled: false,
        sandboxEnabled: false,
        // userId 决定记忆注入的作用域文件（per-user 隔离）
        userId: input.userId,
        // 默认关闭 websearch：测试纯记忆能力，避免消耗搜索 API 额度
        tools: webSearchEnabled ? undefined : [],
        // websearch 关闭 = 纯记忆评测：同时关掉 MCP 与 subagent，否则 lead 仍会
        // 经 task 工具 spawn 出继承全集工具的 subagent（web search / MCP fetch 泄漏）。
        mcpEnabled: webSearchEnabled,
        subagentsEnabled: webSearchEnabled,
      });

      // 根据历史注入模式构建最终消息
      let finalQuery = input.query;
      let systemPrompt: string | undefined;

      if (input.formattedHistory && historyMode !== 'none') {
        if (historyMode === 'prefix') {
          // 将历史拼接到用户消息前面（推荐：模拟真实对话场景）
          finalQuery = buildHistoryPrompt(input.formattedHistory, input.query);
        } else if (historyMode === 'system') {
          // 通过 systemPrompt 注入（需要重建 client）
          systemPrompt = buildSystemHistoryPrompt(input.formattedHistory);
        }
      }

      // 如果使用 system 模式，需要重建 client
      const effectiveClient = systemPrompt
        ? new DeerFlowClient(modelConfig, {
            memoryEnabled,
            autoTitleEnabled: false,
            threadDataEnabled: false,
            uploadsEnabled: false,
            sandboxEnabled: false,
            systemPrompt,
            userId: input.userId,
            tools: webSearchEnabled ? undefined : [],
            mcpEnabled: webSearchEnabled,
            subagentsEnabled: webSearchEnabled,
          })
        : client;

      // 执行 stream 并聚合输出
      let fullText = '';
      let ttftRecorded = false;
      let ttftMs = 0;
      const toolNames: string[] = [];
      const events: ClientAgentEvent[] = [];

      const threadId = randomUUID();
      await runWithContext(
        {
          thread_id: threadId,
          run_id: randomUUID(),
          assistant_id: 'longmem-benchmark',
          user_id: input.userId,
          currentModelConfig: modelConfig,
        },
        async () => {
          for await (const event of effectiveClient.stream(finalQuery, threadId)) {
            events.push(event);

            if (!ttftRecorded && event.eventType === ClientAgentEventType.STREAM_CHUNK) {
              if ((event as any).payload?.text) {
                ttftMs = Date.now() - startTime;
                ttftRecorded = true;
              }
            }

            if (event.eventType === ClientAgentEventType.STREAM_CHUNK) {
              const text = (event as any).payload?.text;
              if (typeof text === 'string') fullText += text;
            }

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
          error: true,
          errorMessage: error?.message ?? String(error),
        },
        events: [],
      };
    }
  };
}

// ── 历史格式化工具 ──

/**
 * 构建 prefix 模式的提示词
 *
 * 格式：
 *   "以下是我们之前的对话记录，请根据这些历史回答我的问题。\n\n
 *    [历史内容]\n\n
 *    我的问题是：[问题]"
 */
function buildHistoryPrompt(history: string, query: string): string {
  return `以下是我们之前的对话记录，请根据这些历史信息回答我的问题。如果你在历史中找不到答案，请直接说明。

${history}

---
**我的问题是：** ${query}`;
}

/**
 * 构建 system prompt 模式的历史注入
 */
function buildSystemHistoryPrompt(history: string): string {
  return `你是一个有长期记忆的 AI 助手。以下是用户的历史对话记录，你需要记住这些信息并在后续对话中使用。

## 用户历史对话记录

${history}

## 重要提醒
- 当用户提问时，优先从上述历史中查找答案
- 如果历史中没有相关信息，请明确告知
- 注意时间顺序和信息的时效性`;
}
