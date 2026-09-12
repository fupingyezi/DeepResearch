/**
 * view_image —— 让模型主动查看本会话中的图片。
 *
 * 存在意义：`vision/vision-middleware.ts` 会把历史图片压成文本占位（否则 base64
 * 每轮重进 checkpoint 并重复付 vision token），但占位符前面的 `[附图: 文件名]`
 * 文本块保留了句柄 —— 模型据此调本工具把图片重新拉回上下文。
 *
 * 设计要点（均经实测/源码确认）：
 * - 返回**多模态 ToolMessage** 而非文本：ToolNode 对 ToolMessage 实例原样采用
 *   （langchain/dist/agents/nodes/ToolNode.js 的 `ToolMessage.isInstance(output)`），
 *   因此 tool_call_id 必须自带 —— 框架不会替你补。
 *   返回 `{ content: [...] }` 普通对象会被 JSON.stringify 成文本，达不到传图效果。
 * - 入参用**文件名**而非 fileId：占位符能自然携带的就是文件名；UUID 让模型逐字抄
 *   36 位错误率高，且 prompt 噪音大。同名取最新。
 * - 图片不写入 state.viewedImages：已内联在 ToolMessage 里，再存一份 base64 是双份存储。
 */

import { tool, type ToolRuntime } from 'langchain';
import z from 'zod';
import { ToolMessage } from '@langchain/core/messages';

import type { UploadedFile } from '../../agents/thread-state';
import { getContext } from '../../runtime/context';
import { getThreadImageFetcher, maxImageBytesFromEnv } from '../../vision';

const ViewImageSchema = z.object({
  description: z.string().min(1).describe('简述为何查看此图片（用于日志/前端展示）。'),
  filename: z
    .string()
    .min(1)
    .describe('要查看的图片文件名，取自本会话上传文件清单或消息中的 [附图: xxx] 标注。'),
});

/** 从 runtime.state 读本会话上传文件（单层断言，外部边界例外）。 */
function resolveUploadedImages(runtime: ToolRuntime): UploadedFile[] {
  const state = (runtime.state ?? {}) as { uploadedFiles?: UploadedFile[] | null };
  const files = state.uploadedFiles ?? [];
  return files.filter((f) => (f.mimeType ?? '').startsWith('image/'));
}

export const viewImageTool = tool(
  async (input, runtime: ToolRuntime) => {
    const { description, filename } = input;

    // 非视觉模型不能收 image blocks，否则 provider 直接报错
    if (getContext()?.currentModelConfig?.supportsVision !== true) {
      return '当前模型不支持图片理解，无法查看图片。可按文件名与用户确认，或请用户改用支持视觉的模型。';
    }

    const images = resolveUploadedImages(runtime);
    if (images.length === 0) return '本会话没有可用图片。';

    const matched = images.filter((f) => f.filename === filename);
    if (matched.length === 0) {
      return `未找到图片 "${filename}"。本会话可用图片：${images
        .map((f) => f.filename ?? '(未命名)')
        .join('、')}`;
    }
    const ref = matched[matched.length - 1]; // 同名取最新

    const fetcher = getThreadImageFetcher();
    if (!fetcher) return '图片读取通道未就绪（服务端未注册 fetcher），请稍后再试。';

    const fetched = await fetcher({
      fileId: ref.fileId ?? '',
      filename: ref.filename,
      mimeType: ref.mimeType,
      minioKey: ref.minioKey,
      sizeBytes: ref.sizeBytes,
    });
    if (!fetched)
      return `图片 "${filename}" 读取失败（可能已删除、超过大小上限或对象存储未就绪）。`;

    const rawBytes = Math.ceil((fetched.base64.length * 3) / 4);
    if (rawBytes > maxImageBytesFromEnv()) {
      return `图片 "${filename}" 超过大小上限，无法加载。`;
    }

    return new ToolMessage({
      content: [
        { type: 'text', text: `${description}\n已加载图片: ${filename}` },
        {
          type: 'image_url',
          image_url: { url: `data:${fetched.mimeType};base64,${fetched.base64}` },
        },
      ],
      tool_call_id: runtime.toolCallId,
      name: 'view_image',
    });
  },
  {
    name: 'view_image',
    description:
      '查看本会话中的图片（按文件名）。适用于历史图片已被折叠为 [图片已查看]、' +
      '或需要重新仔细观察某张图时。文件名见消息中的 [附图: xxx] 标注或上传文件清单。',
    schema: ViewImageSchema,
  },
);
