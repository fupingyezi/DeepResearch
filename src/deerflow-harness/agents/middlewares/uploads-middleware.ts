import { SystemMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

import { getContext } from '../../runtime/context';
import type { UploadedFile } from '../thread-state';
import { loadSessionUploadedFiles } from './thread-data-middleware';

/**
 * UploadsMiddleware（基础设施）
 *
 * 职责：
 * - `beforeAgent` 把本会话上传文件渲染为一段带特征 tag 的 markdown SystemMessage，
 *   追加到 messages 末尾，让 LLM 看到文件元信息 + 解析后正文（含图片 OCR 文本，截断）。
 *
 * 取数来源（**两段式，缺一不可**）：
 * 1. 优先 `state.uploadedFiles`（ThreadDataMiddleware 写入）；
 * 2. 为空时**自行按 thread_id 查库**。
 *
 * 为什么必须能自行取数：LangChain v1 的中间件节点输入被限制为该中间件自身声明的私有
 * state + `messages`（`MiddlewareNode.nodeOptions.input = derivePrivateState(stateSchema)`），
 * 因此**上游中间件写的 state 在下游读不到** —— 只依赖 (1) 会导致注入永不发生
 * （实测：state.uploadedFiles 恒为 undefined、tag 从未出现在 messages 中）。
 *
 * 防重：
 * - 通过特征 tag `<!-- uploads-context -->` 判定（扫现有 messages，命中则跳过）。
 *   add_messages 默认按 id 合并，本中间件不给注入消息分配 id，故每次进入都会追加；
 *   tag 是阻止"同一 run 多次 beforeAgent 入口"重复注入的唯一手段。
 *
 * 顺序：与 ThreadDataMiddleware 的先后不再有语义依赖（自行取数兜底），仍保持位序在后。
 *
 * 错误隔离：任何异常仅 console.error，不影响主流程。
 */

const UPLOADS_CONTEXT_TAG = '<!-- uploads-context -->';

/** 单文件 content 截断上限：8000 char，超过追加 `…[truncated]` 标记。 */
const CONTENT_TRUNCATE_LIMIT = 8000;

export const uploadsMiddleware = createMiddleware({
  name: 'UploadsMiddleware',
  beforeAgent: async (state: any) => {
    try {
      let files = state?.uploadedFiles as UploadedFile[] | null | undefined;

      // 上游写入读不到（见上方注释）→ 自行按 thread_id 取数
      if (!Array.isArray(files) || files.length === 0) {
        const threadId = getContext()?.thread_id;
        if (!threadId) return undefined;
        files = await loadSessionUploadedFiles(threadId);
      }
      if (!Array.isArray(files) || files.length === 0) return undefined;

      // 防重：messages 中已存在特征 tag 则跳过
      const messages = Array.isArray(state?.messages) ? state.messages : [];
      if (hasInjectedTag(messages)) return undefined;

      const markdown = buildUploadsMarkdown(files);
      if (!markdown) return undefined;

      return {
        messages: [new SystemMessage(markdown)],
      };
    } catch (e) {
      console.error('[uploadsMiddleware] beforeAgent error:', e);
      return undefined;
    }
  },
});

function hasInjectedTag(messages: unknown[]): boolean {
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const content = (msg as { content?: unknown }).content;
    if (typeof content === 'string' && content.startsWith(UPLOADS_CONTEXT_TAG)) {
      return true;
    }
  }
  return false;
}

function buildUploadsMarkdown(files: UploadedFile[]): string {
  const lines: string[] = [];
  lines.push(UPLOADS_CONTEXT_TAG);
  lines.push('## 用户上传的文件');
  lines.push('');

  files.forEach((file, idx) => {
    const filename = (file as Record<string, unknown>).filename as string | undefined;
    const mimeType = (file as Record<string, unknown>).mimeType as string | undefined;
    const sizeBytes = (file as Record<string, unknown>).sizeBytes as number | undefined;
    const content = (file as Record<string, unknown>).content as string | null | undefined;

    const sizeLabel = formatBytes(sizeBytes);
    const mimeLabel = mimeType && mimeType.length > 0 ? mimeType : 'unknown';
    const nameLabel = filename && filename.length > 0 ? filename : `file-${idx + 1}`;

    lines.push(`### ${idx + 1}. ${nameLabel} (${mimeLabel}, ${sizeLabel})`);
    lines.push('');

    if (typeof content === 'string' && content.length > 0) {
      const total = content.length;
      const truncated =
        total > CONTENT_TRUNCATE_LIMIT
          ? `${content.slice(0, CONTENT_TRUNCATE_LIMIT)}\n…[truncated, total ${total} chars]`
          : content;
      lines.push('<content>');
      lines.push(truncated);
      lines.push('</content>');
    } else {
      lines.push('<content>(无解析内容；可通过文件名 / mime 与用户确认)</content>');
    }
    lines.push('');
  });

  return lines.join('\n');
}

function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
