import mammoth from 'mammoth';
import { getMinioClient, getMimeType } from '@/lib/storage';
import { MODEL_PRESETS } from '@/config/models';

async function downloadFileFromMinio(bucket: string, key: string): Promise<Buffer> {
  const stream = await getMinioClient().getObject(bucket, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 智谱默认端点（OpenAI 兼容 chat 与原生 layout_parsing 同源）。 */
const ZHIPU_DEFAULT_BASE = 'https://open.bigmodel.cn/api/paas/v4';
/** glm-ocr 单图上限（字节）。 */
const OCR_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/**
 * 降级用的视觉模型：直接取 preset 的 modelName，改名会变成编译期错误而非静默跑空。
 * 用于 layout_parsing 拒绝某些合法图片时的兜底（实测该端点格式校验会误拒）。
 */
const FALLBACK_VISION_MODEL = MODEL_PRESETS['zhipu-glm-5.3-flash'].modelName;

const OCR_EXTRACT_PROMPT =
  '提取图中所有可见文字，按阅读顺序输出为 markdown，不要任何额外说明；若图中没有文字，则简要描述图像内容。';

function zhipuBase(): string {
  return (process.env.ZHIPU_BASE_URL || ZHIPU_DEFAULT_BASE).replace(/\/$/, '');
}

/** 归一化 MIME：image/jpg 非标准名；非 image/* 时按扩展名兜底（智谱只认 image/*）。 */
function normalizeImageMime(mimeType: string, filename: string): string {
  if (mimeType === 'image/jpg') return 'image/jpeg';
  if (mimeType.startsWith('image/')) return mimeType;
  return getMimeType(filename.split('.').pop() ?? '');
}

/** OCR 不出来的占位文本（永不抛错，见下方 ocrImageFromZhipu 注释）。 */
function ocrFallbackNote(filename: string, reason: string): string {
  return `[图片文件 ${filename}：未能提取文字（${reason}）。如当前模型支持视觉，可直接理解该图。]`;
}

/** 主路径：智谱原生 OCR（layout_parsing 专用端点，非 chat 协议）。 */
async function ocrWithLayoutParsing(dataUri: string, apiKey: string): Promise<string | null> {
  const model = process.env.ZHIPU_OCR_MODEL || 'glm-ocr';
  try {
    const res = await fetch(`${zhipuBase()}/layout_parsing`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, file: dataUri }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.warn(
        '[file-parser] layout_parsing failed:',
        res.status,
        await res.text().catch(() => ''),
      );
      return null;
    }
    const json = (await res.json()) as { md_results?: unknown };
    const md = typeof json?.md_results === 'string' ? json.md_results.trim() : '';
    return md || null;
  } catch (e) {
    console.warn('[file-parser] layout_parsing error:', e);
    return null;
  }
}

/** 降级路径：用视觉模型「读图转 markdown」（与聊天传图同一条已验证的 base64 通道）。 */
async function ocrWithVisionModel(dataUri: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${zhipuBase()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: FALLBACK_VISION_MODEL,
        // glm-5.3-flash 是推理模型，reasoning 计入 completion_tokens，
        // 预算过小会导致 content 为空（实测 max_tokens=32 时返回空串）。
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: OCR_EXTRACT_PROMPT },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      console.warn(
        '[file-parser] vision fallback failed:',
        res.status,
        await res.text().catch(() => ''),
      );
      return null;
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = json?.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content.trim() : '';
    return text || null;
  } catch (e) {
    console.warn('[file-parser] vision fallback error:', e);
    return null;
  }
}

/**
 * 图片 → 文字（layout_parsing 主路径，视觉模型兜底）。
 *
 * **永不抛错**：`/api/files/upload` 把解析异常记为 status='failed'，而
 * `chat-input.tsx` 有 `every(f => f.parsedStatus === 'success')` 的硬门禁 ——
 * 一旦抛错，用户传了图就**根本发不出这条消息**（哪怕模型有视觉能力、图片完全可用）。
 * 因此失败时返回说明性占位文本：非视觉模型也能从 uploads 上下文知道「有张图但没读出文字」。
 *
 * 实测依据：layout_parsing 的格式校验会拒绝某些合法图片（同一张图视觉模型能正常识别），
 * 故不能只走一条路。
 */
export async function ocrImageFromZhipu(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<string> {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) return ocrFallbackNote(filename, '未配置 ZHIPU_API_KEY');
  if (buffer.length > OCR_MAX_IMAGE_BYTES) {
    return ocrFallbackNote(filename, '超过单图 10MB 上限');
  }

  // data URI 而非裸 base64：实测裸 base64 会被拒（code 1214）
  const dataUri = `data:${normalizeImageMime(mimeType, filename)};base64,${buffer.toString('base64')}`;

  const viaOcr = await ocrWithLayoutParsing(dataUri, apiKey);
  if (viaOcr) return viaOcr;

  const viaVision = await ocrWithVisionModel(dataUri, apiKey);
  if (viaVision) return viaVision;

  return ocrFallbackNote(filename, 'OCR 与视觉模型均未返回结果');
}

export async function extractTextFromFile(
  bucket: string,
  key: string,
  mimeType: string,
  filename: string,
): Promise<string> {
  try {
    const buffer = await downloadFileFromMinio(bucket, key);

    // 图片：走 OCR，且**直接返回**——不经下方的空白折叠，否则 OCR 产出的
    // markdown 标题层级与表格结构会被压平，等于废掉结构化提取的主要价值。
    if (mimeType.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(filename)) {
      return await ocrImageFromZhipu(buffer, mimeType, filename);
    }

    let text = '';

    if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
      try {
        const pdf = (await import('pdf-parse')).default;
        const data = await pdf(buffer);
        text = data.text || '';
      } catch (pdfError) {
        throw new Error(
          `Failed to parse PDF: ${pdfError instanceof Error ? pdfError.message : 'Unknown error'}`,
        );
      }
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      filename.endsWith('.docx')
    ) {
      try {
        const result = await mammoth.extractRawText({ buffer });
        text = result.value || '';
      } catch (docxError) {
        throw new Error(
          `Failed to parse DOCX: ${
            docxError instanceof Error ? docxError.message : 'Unknown error'
          }`,
        );
      }
    } else if (
      filename.endsWith('.md') ||
      filename.endsWith('.txt') ||
      mimeType.startsWith('text/')
    ) {
      try {
        text = buffer.toString('utf-8');
      } catch (textError) {
        throw new Error(
          `Failed to parse text file: ${
            textError instanceof Error ? textError.message : 'Unknown error'
          }`,
        );
      }
    } else {
      throw new Error(`Unsupported file type: ${mimeType} (${filename})`);
    }

    return text.replace(/\s+/g, ' ').trim();
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`File parsing failed: ${String(error)}`);
  }
}
