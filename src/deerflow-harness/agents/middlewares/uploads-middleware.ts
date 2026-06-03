import { SystemMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

import type { UploadedFile } from '../thread-state';

/**
 * UploadsMiddleware（基础设施）
 *
 * 职责：
 * - `beforeAgent` 把 `state.uploadedFiles`（由 ThreadDataMiddleware 装载）渲染为一段
 *   带特征 tag 的 markdown SystemMessage，追加到 messages 末尾，让 LLM 看到本会话
 *   上传文件的元信息 + 解析后正文（截断）。
 *
 * 防重：
 * - 通过特征 tag `<!-- uploads-context -->` 判定（扫现有 messages，命中则跳过）。
 *   add_messages 默认按 id 合并，本中间件不给注入消息分配 id，故每次进入都会追加；
 *   tag 是阻止"同一 run 多次 beforeAgent 入口"重复注入的唯一手段。
 *
 * 顺序：排在 ThreadDataMiddleware 之后；由 `ORDERED_MIDDLEWARES` 位序保证。
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
      const files = state?.uploadedFiles as UploadedFile[] | null | undefined;
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
