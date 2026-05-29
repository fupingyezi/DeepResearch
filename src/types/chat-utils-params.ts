import { ConversationState } from '@/store';
import type { ModelPresetName } from '@/config/models';
import type { ChatUploadedFileRef } from './chat-info-define';

/**
 * 统一聊天入口参数。
 * 是否进入深度研究流程由后端 lead-agent 自主判断，前端不再传任何档位字段。
 */
export interface chatWithAgentProps extends ConversationState {
  inputValue: string;
  /** 用户上传的文件（前端上传后拿到的元信息列表），仅在普通发送（无 operation）时生效 */
  uploadedFiles?: ChatUploadedFileRef[];
  /** 操作类型：'resume' / 'recall' / 'reEditCall'，无 operation 时默认为 'direct'*/
  operation?: 'resume' | 'recall' | 'reEditCall';
  /** 仅 operation === 'resume' 时使用：'确认'/'拒绝' 等 */
  resumeDecision?: string;
  /** 模型预设标识（前端 UI 层语法糖，由 chat-with-agent 映射成 configuration.model.value） */
  model?: ModelPresetName;
}

/**
 * 重新编辑/重试时使用，落在与 chatWithAgent 一致的合并入口上。
 */
export interface reChatWithAgentProps extends ConversationState {
  inputValue: string;
  operation: 'reEditCall' | 'recall';
  model?: ModelPresetName;
}
