/**
 * 视觉子系统：线程图片字节访问注入 + 多模态消息构造
 *
 * 依赖方向约束：harness 层不反向依赖 app 层（MinIO 客户端在 src/lib/storage），
 * 因此图片字节获取器由 app 层（threads/_service.ts）通过 setThreadImageFetcher
 * 注入，模式对齐 setMemoryModelFactory / setTitleModelFactory。
 *
 * 传输用 base64 data URL：内网部署下 MinIO presigned URL 对模型服务商不可达，
 * base64 是唯一可靠通道（智谱 chat 兼容接口支持 image_url data URL）。
 */

import type { ContentBlock } from '@langchain/core/messages';

export interface ThreadImageRef {
  fileId: string;
  filename?: string;
  mimeType?: string;
  minioKey?: string;
  /** DB 里的字节数：fetcher 可据此在拉取前直接拒绝超限图，避免白拉一次 50MB。 */
  sizeBytes?: number;
}

export interface FetchedImage {
  base64: string;
  mimeType: string;
}

/** 由 app 层注册（MinIO getFile 实现）；未注册时所有图片降级为纯文本。 */
export type ThreadImageFetcher = (ref: ThreadImageRef) => Promise<FetchedImage | null>;

let _fetcher: ThreadImageFetcher | null = null;

export function setThreadImageFetcher(fetcher: ThreadImageFetcher | null): void {
  _fetcher = fetcher;
}

export function getThreadImageFetcher(): ThreadImageFetcher | null {
  return _fetcher;
}

/** 单图字节上限（raw bytes；base64 会再膨胀 ~33%），env 可调。 */
export function maxImageBytesFromEnv(): number {
  const mb = Number(process.env.DEERFLOW_VISION_MAX_IMAGE_MB);
  if (Number.isFinite(mb) && mb > 0) return Math.round(mb * 1024 * 1024);
  return 5 * 1024 * 1024;
}

export interface BuildContentOptions {
  supportsVision: boolean;
  maxImageBytes: number;
}

export interface BuildContentResult {
  /**
   * 纯文本时为 string（与现状完全一致），带图时为 content blocks。
   *
   * 类型用 `ContentBlock`（`@langchain/core` 现行导出；`MessageContentComplex`
   * 已标记 @deprecated 且其 `type?: string | undefined` 与 HumanMessage 构造签名冲突）。
   */
  content: string | ContentBlock[];
  /** 成功附加进 blocks 的图片数。 */
  attached: number;
  /** 降级（fetch 失败 / 超限 / 非视觉模型）的图片文件名。 */
  degraded: string[];
}

/**
 * 组装首轮 HumanMessage content（纯函数 + 注入的 fetcher，便于单测）：
 * - supportsVision=false 或无图 → 原样返回 string content（现状行为）；
 * - 全部图片降级 → 仍返回 string，但附上降级说明文本；
 * - 部分成功 → text block 在前，image_url blocks 在后，降级项附注。
 */
export async function buildHumanMessageContent(
  message: string,
  images: ThreadImageRef[],
  opts: BuildContentOptions,
): Promise<BuildContentResult> {
  if (!opts.supportsVision || images.length === 0) {
    return { content: message, attached: 0, degraded: images.map((i) => i.filename ?? i.fileId) };
  }

  const fetcher = getThreadImageFetcher();
  if (!fetcher) {
    return { content: message, attached: 0, degraded: images.map((i) => i.filename ?? i.fileId) };
  }

  const blocks: ContentBlock[] = [];
  const degraded: string[] = [];
  const notes: string[] = [];
  let attached = 0;

  for (const ref of images) {
    const displayName = ref.filename ?? ref.fileId;
    try {
      // DB 已知字节数且超限 → 连拉取都省掉
      if (typeof ref.sizeBytes === 'number' && ref.sizeBytes > opts.maxImageBytes) {
        degraded.push(displayName);
        notes.push(`[图片 ${displayName} 超过大小上限，未能加载]`);
        continue;
      }
      const image = await fetcher(ref);
      if (!image) throw new Error('fetcher returned null');
      const rawBytes = Math.ceil((image.base64.length * 3) / 4); // base64 → 原始字节近似
      if (rawBytes > opts.maxImageBytes) {
        degraded.push(displayName);
        notes.push(`[图片 ${displayName} 超过大小上限，未能加载]`);
        continue;
      }
      // 文本标签先于 image block：历史图被 visionMiddleware 压成占位后，
      // 文件名仍留在文本里，模型可据此调 view_image 重新查看。文本块不会被压缩。
      blocks.push({ type: 'text', text: `[附图: ${displayName}]` });
      // 线上格式必须是 OpenAI 的 `image_url`：@langchain/openai 只转换「带 source_type
      // 的 data block」，其余 content block 原样透传给 provider。若改成语义上更"标准"的
      // ContentBlock.Multimodal.Image，会被原样发给智谱并 400（无 source_type 不走转换）。
      blocks.push({
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
      });
      attached += 1;
    } catch (e) {
      console.warn(`[vision] Failed to load image ${displayName}:`, e);
      degraded.push(displayName);
      notes.push(`[图片 ${displayName} 无法加载]`);
    }
  }

  if (attached === 0) {
    // 一张都没成：不构造 blocks（部分数组 content 部分文本的场景交给 notes 说明）
    const text = notes.length ? `${message}\n${notes.join('\n')}` : message;
    return { content: text, attached: 0, degraded };
  }

  const textBlock = notes.length ? `${message}\n${notes.join('\n')}` : message;
  return {
    content: [{ type: 'text', text: textBlock }, ...blocks],
    attached,
    degraded,
  };
}
