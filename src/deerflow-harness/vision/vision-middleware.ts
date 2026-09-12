/**
 * VisionMiddleware（features.vision 启用时挂载）
 *
 * 职责：**历史图片压缩**。多模态 HumanMessage / ToolMessage 的 image_url blocks
 * 携带 base64 data URL，而 checkpoint 每轮重放全部历史——不压缩会导致：
 * 1. 同一张图每轮重复写进 PG checkpoint blob（体积膨胀）；
 * 2. 每轮重付 vision token（历史图对模型已无增量信息）。
 *
 * 策略：beforeAgent 扫描 state.messages，除「最后一条含图 HumanMessage」
 * （本轮新输入，模型需要看）外，把所有 image_url blocks 替换为文本占位。
 * 克隆消息时保留原 id —— messages channel 的 add_messages reducer 按 id
 * merge，原地替换语义；无 id 的消息跳过（append 语义会导致重复）。
 *
 * **顺序不变量（依赖 LangGraph 结构，与本中间件在链上的位序无关）**：
 * 本中间件用 beforeAgent，而 summarizationMiddleware 用 beforeModel，
 * BeforeAgentNode 严格先于模型循环的 BeforeModelNode → 压缩**永远**先于摘要。
 * 这点很关键：摘要器会把待摘要消息 `JSON.stringify` 进摘要 prompt 的纯文本
 * （`summaryPrompt.replace('{messages}', JSON.stringify(trimmedMessages))`），
 * 未压缩的 base64 会变成数 MB 的文本灌进摘要请求。
 *
 * 已知残留：resumeStream（Command({resume})）当轮没有新 HumanMessage，
 * lastHumanIndex 落在旧图上 → 那一轮不压缩（少省一次 token，无正确性问题）。
 */

import { createMiddleware } from 'langchain';
import { HumanMessage, ToolMessage, type ContentBlock } from '@langchain/core/messages';

/** content 中是否含 image_url blocks。 */
export function contentHasImageBlocks(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      block && typeof block === 'object' && (block as { type?: string }).type === 'image_url',
  );
}

/**
 * 把 content 数组中的 image blocks 替换为文本占位。
 * string content 原样返回；形态未知（非 string 也非数组）返回 null 表示「跳过该消息」。
 */
function replaceImageBlocks(content: unknown): string | ContentBlock[] | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content.map((block) =>
    block && typeof block === 'object' && (block as { type?: string }).type === 'image_url'
      ? // 教模型重看路径：文件名留在前一条 [附图: xxx] 文本块里，据此可调 view_image
        { type: 'text', text: '[图片已查看，可用 view_image 重新查看]' }
      : block,
  );
}

function getMessageType(msg: any): string {
  if (typeof msg?._getType === 'function') return msg._getType();
  return typeof msg?.type === 'string' ? msg.type : 'unknown';
}

/** 按消息类型克隆并替换 content（保留 id / tool_call_id 等关键元数据）。 */
function cloneWithCompressedImages(msg: any): any {
  const content = replaceImageBlocks(msg.content);
  // 形态未知（content 缺失或非 string/数组）：不动，避免把 undefined 写进消息
  if (content === null) return msg;
  switch (getMessageType(msg)) {
    case 'human':
      return new HumanMessage({ content, id: msg.id });
    case 'tool':
      return new ToolMessage({
        content,
        id: msg.id,
        tool_call_id: msg.tool_call_id,
        name: msg.name,
      });
    default:
      // AI（输出恒为文本，不会带图）/ System / 未知类型：不动，避免破坏消息形态
      return msg;
  }
}

export const visionMiddleware = createMiddleware({
  name: 'VisionMiddleware',
  beforeAgent: async (state: any) => {
    try {
      const messages = state?.messages;
      if (!Array.isArray(messages) || messages.length === 0) return undefined;

      // 找最后一条 HumanMessage：若含图则保留（本轮新输入），更早的全部压缩
      let lastHumanIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (getMessageType(messages[i]) === 'human') {
          lastHumanIndex = i;
          break;
        }
      }

      let changed = false;
      const next = messages.map((msg: any, i: number) => {
        // 无 id 的消息经 add_messages 是 append 语义，替换会造成重复，跳过
        if (i === lastHumanIndex || !msg?.id) return msg;
        if (!contentHasImageBlocks(msg.content)) return msg;
        changed = true;
        return cloneWithCompressedImages(msg);
      });

      return changed ? { messages: next } : undefined;
    } catch (e) {
      console.error('[visionMiddleware] beforeAgent error:', e);
      return undefined;
    }
  },
});
