/**
 * 阶段 C 过渡垫片：把旧 conversations/_service.ts 的导出名转发到三层化后的
 * @/server/services/conversation-service 与各 DAO 类型。
 *
 * v3/chat 路由阶段 E 拆分后直接改走 conversation-service，本文件随之删除。
 */

import type { CreateChatSessionInput } from '@/server/daos/chat-session';
import {
  getConversationService,
  type InsertAssistantMessageInput,
  type InsertUserMessageInput,
  type LatestMessageRow,
} from '@/server/services/conversation-service';

export { ChatSessionAccessError } from '@/server/daos/chat-session';
export type { ChatSessionRecord } from '@/server/daos/chat-session';
export type { SavedFileMetadata } from '@/server/daos/file-metadata';
export type { InsertUserMessageInput, InsertAssistantMessageInput, LatestMessageRow };

export function ensureChatSessionRecord(input: CreateChatSessionInput) {
  return getConversationService().ensureSession(input);
}

export function insertUserMessageRecord(input: InsertUserMessageInput) {
  return getConversationService().saveUserMessage(input);
}

export function insertAssistantMessageRecord(input: InsertAssistantMessageInput) {
  return getConversationService().saveAssistantMessage(input);
}

export function updateAssistantMessageParts(input: {
  messageId: string;
  parts: InsertAssistantMessageInput['parts'];
}) {
  return getConversationService().updateAssistantParts(input.messageId, input.parts);
}

export function getLatestAssistantMessageWithParts(sessionId: string, userId: string) {
  return getConversationService().getLatestAssistantWithParts(sessionId, userId);
}

export function resolveFilesByIds(fileIds: string[]) {
  return getConversationService().resolveFilesByIds(fileIds);
}

export function deleteMessagesAtOrAfter(sessionId: string, fromCreatedAt: string | Date) {
  return getConversationService().deleteMessagesAtOrAfter(sessionId, fromCreatedAt);
}

export function getLatestMessageByRole(sessionId: string, role: 'user' | 'assistant') {
  return getConversationService().getLatestMessageByRole(sessionId, role);
}

export function waitRunError(runId: string, timeoutMs?: number) {
  return getConversationService().waitRunError(runId, timeoutMs);
}
