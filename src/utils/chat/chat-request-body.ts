/**
 * chat-request-body
 *
 * `/api/v3/chat` 请求体的纯组装函数（逻辑迁移自旧 StreamChatHandler.executeStreamRequest）。
 *
 * 单独成模块的理由与 chat-configuration 相同：不进 React 组件 import 链，node 环境
 * 可直接单测；请求体是前后端线协议的一部分，字段被静默丢弃时（历史教训：metadata
 * 展开、字段名拼写）功能会悄悄失效，需要被单测钉住。
 *
 * 约定：
 * - `resume` 的 inputText 优先取 resumeDecision（用户对中断问题的应答）
 * - 附件只在普通发送（无 operation）时携带（与后端 message.contents 语义一致）
 * - 新建对话（isNewSession）不携带 sessionId，由后端新建并在 START 回传真实 id
 */

import type { ChatUploadedFileRef, MemoryInjectionMode } from '@/types';
import type { ModelPresetName } from '@/config/models';
import { buildChatConfiguration } from './chat-configuration';

export type RunOperation = 'resume' | 'recall' | 'reEditCall';

export interface ChatRequestBodyInput {
  inputValue: string;
  operation?: RunOperation;
  /** 仅 operation === 'resume' 时使用：'确认'/'拒绝'等 human-in-the-loop 决策文本 */
  resumeDecision?: string;
  uploadedFiles?: ChatUploadedFileRef[];
  /** 模型预设标识（映射成 configuration.model.value） */
  model?: ModelPresetName;
  /** 记忆注入模式；缺省不传该字段，后端按服务级默认 inject 处理 */
  memoryMode?: MemoryInjectionMode;
  sessionId?: string;
  /** 新建对话：请求体不携带 sessionId（后端新建并在 START 回传真实 id） */
  isNewSession?: boolean;
}

/** 泵的一次 run 入参：请求体字段 + 可选的外部中断信号（isNewSession 由泵按 sid 派生） */
export interface RunOptions extends ChatRequestBodyInput {
  signal?: AbortSignal;
}

export function buildChatRequestBody(input: ChatRequestBodyInput): Record<string, unknown> {
  const isResumeOp = input.operation === 'resume';
  const inputText = isResumeOp
    ? (input.resumeDecision ?? input.inputValue ?? '')
    : input.inputValue;

  const contents: Array<
    | { type: 'text'; text: string }
    | { type: 'file'; fileId: string }
    | { type: 'image'; fileId: string }
  > = [{ type: 'text', text: inputText }];

  if (input.operation === undefined && Array.isArray(input.uploadedFiles)) {
    for (const file of input.uploadedFiles) {
      if (!file || typeof file.fileId !== 'string' || file.fileId.length === 0) continue;
      const mimeType = typeof file.mimeType === 'string' ? file.mimeType : '';
      contents.push({
        type: mimeType.startsWith('image/') ? 'image' : 'file',
        fileId: file.fileId,
      });
    }
  }

  const requestBody: Record<string, unknown> = {
    message: { contents },
    stream: true,
  };

  if (!input.isNewSession && input.sessionId) {
    requestBody.sessionId = input.sessionId;
  }

  // configuration 一次性组装（model + memoryMode），避免多处赋值互相覆盖
  const configuration = buildChatConfiguration({
    model: input.model,
    memoryMode: input.memoryMode,
  });
  if (Object.keys(configuration).length > 0) {
    requestBody.configuration = configuration;
  }

  if (input.operation !== undefined) {
    requestBody.operation = input.operation;
  }

  return requestBody;
}
