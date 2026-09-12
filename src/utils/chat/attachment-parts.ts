import { v4 as uuidv4 } from 'uuid';

import type { ChatUploadedFileRef, MessagePart } from '@/types';

/**
 * 把本轮上传的附件转成 user message 的 file / image parts。
 *
 * 用途：本地乐观消息（发送瞬间就渲染的那条）需要自带附件 part —— 否则用户刚发出
 * 带附件的消息时，气泡里只有一个文本块、看不到附件（历史加载走 message.files，
 * 所以刷新页面后反而正常）。
 *
 * 与后端 `contentsToUserParts` 的形状保持一致（同一套 MessagePart 契约），
 * 便于实时/历史两种路径渲染出同样的卡片。
 *
 * 单独成模块（而非留在 stream-chat-handler.ts 内）：那里 import 链会拉到 React
 * 组件，而 node 环境的单测无法 transform JSX（tsconfig 的 jsx: preserve）。
 */
export function buildAttachmentParts(files?: ChatUploadedFileRef[]): MessagePart[] {
  if (!Array.isArray(files) || files.length === 0) return [];
  const createdAt = Date.now();
  return files.map((file): MessagePart => {
    const content = {
      fileId: file.fileId,
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
    };
    return file.mimeType?.startsWith('image/')
      ? { partId: uuidv4(), type: 'image', createdAt, content }
      : { partId: uuidv4(), type: 'file', createdAt, content };
  });
}
