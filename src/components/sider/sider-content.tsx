'use client';

import {
  PlusCircleOutlined,
  EllipsisOutlined,
  EditOutlined,
  DeleteOutlined,
  SettingOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { Popover, Modal } from 'antd';

import { useCallback, useEffect, useState } from 'react';
import React from 'react';
import { ChatSessionType } from '@/types';
import type { SessionRunStatus } from '@/store/chat-session-store';
import apiClient from '@/utils/request/api';
import { useConversationStore } from '@/store';
import { UUIDTypes } from 'uuid';
import { formatYmd } from '@/utils/common';
import { useOutsideClick } from '@/hooks';
import { useAuth } from '@/runtime/context/auth-provider';
import { SettingsDialog } from '@/components/settings/settings-dialog';

interface SessionBubbleProps {
  chatSession: ChatSessionType;
  isShowDate: boolean;
  selectedSession: ChatSessionType | null;
  isModalOpen: boolean;
  setSelectedSession: (selectedSession: ChatSessionType) => void;
  setIsModalOpen: (isModalOpen: boolean) => void;
  setSelectedModal: (selectedModal: 'edit' | 'delete') => void;
}

async function getConversationSessions() {
  try {
    const data = await apiClient.get('/conversations/get_all_sessions');
    return data;
  } catch (error) {
    console.error('Failed to fetch conversation sessions:', error);
    return { data: [] };
  }
}

/**
 * 对话运行状态标识（多对话并行可视化）：
 * - running：转圈 loading，表示该对话正在后台跑（无论是否为当前查看对话）。
 * - done：绿点，表示已跑完。
 * - error：红点，表示本轮出错。
 * - idle / 无运行桶：不显示（保持列表干净）。
 */
const SessionStatusIndicator: React.FC<{ status?: SessionRunStatus }> = ({ status }) => {
  if (status === 'running') {
    return <LoadingOutlined className="shrink-0 text-[#0f766e]" style={{ fontSize: 14 }} />;
  }
  if (status === 'done') {
    return <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" aria-label="已完成" />;
  }
  if (status === 'error') {
    return <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="出错" />;
  }
  return null;
};

const SessionBubble: React.FC<SessionBubbleProps> = React.memo(
  ({
    chatSession,
    isShowDate = false,
    isModalOpen,
    selectedSession,
    setSelectedSession,
    setIsModalOpen,
    setSelectedModal,
  }) => {
    const [isHover, setIsHover] = useState<boolean>(false);

    const { currentSessionId, setCurrentSessionId, getSessionRuntime, setSessionMessages } =
      useConversationStore();
    const runtimeStatus = useConversationStore(
      (s) => s.sessionRuntimes[String(chatSession.id)]?.status,
    );
    const showDate = formatYmd(chatSession.updated_at);

    const handleSelectSession = async (sessionId: UUIDTypes) => {
      // 先切当前对话：store 会从该对话的运行桶恢复投影（含正在流式的消息与运行态）。
      setCurrentSessionId(sessionId);
      // 已有运行桶（正在跑或跑过）：直接用桶内消息，绝不拉历史覆盖正在流式的内容。
      if (getSessionRuntime(String(sessionId))) return;
      try {
        const response = await apiClient.get(
          `/conversations/history?sessionId=${encodeURIComponent(String(sessionId))}`,
        );
        // 写入该对话的桶（并投影到当前视图）；不触碰其它正在跑的对话。
        setSessionMessages(String(sessionId), response.data);
      } catch (error) {
        console.error('error:', error);
      }
    };

    return (
      <>
        {isShowDate && (
          <div className="mt-3 mb-1 w-full px-3 text-[11px] font-medium tracking-wide text-[#9ca3af]">
            {showDate}
          </div>
        )}
        <Popover
          content={
            <div onClick={(e) => e.stopPropagation()}>
              <div
                className="flex items-center gap-2 rounded-md px-2 py-1 hover:cursor-pointer hover:bg-gray-100"
                onClick={() => {
                  setIsModalOpen(true);
                  setSelectedModal('edit');
                }}
              >
                <EditOutlined />
                重命名
              </div>
              <div
                className="flex items-center gap-2 rounded-md px-2 py-1 text-red-600 hover:cursor-pointer hover:bg-gray-100"
                onClick={() => {
                  setIsModalOpen(true);
                  setSelectedModal('delete');
                }}
              >
                <DeleteOutlined /> 删除此对话
              </div>
            </div>
          }
          placement="right"
          open={selectedSession?.id === chatSession.id && !isModalOpen}
        >
          <div
            className="relative flex min-h-10 w-full items-center gap-2 overflow-hidden rounded-xl px-3 leading-10 transition-colors hover:cursor-pointer hover:bg-[#eef0f2]"
            style={{
              backgroundColor: chatSession.id === currentSessionId ? '#d7f2f0' : '',
              color: chatSession.id === currentSessionId ? '#0f766e' : '#374151',
              fontWeight: chatSession.id === currentSessionId ? 600 : 400,
            }}
            onMouseEnter={() => setIsHover(true)}
            onMouseLeave={() => setIsHover(false)}
            onClick={() => handleSelectSession(chatSession.id)}
          >
            <SessionStatusIndicator status={runtimeStatus} />
            <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
              {chatSession.title}
            </span>
            {isHover && (
              <div
                className={`absolute top-1/2 right-0 flex h-full w-9 -translate-y-1/2 transform items-center justify-center ${
                  chatSession.id === currentSessionId ? 'bg-[#d7f2f0]' : 'bg-[#eef0f2]'
                }`}
              >
                <EllipsisOutlined
                  className={`h-6 w-6 rounded-full p-0.5 ${
                    chatSession.id === currentSessionId
                      ? 'hover:bg-[#bfe9e5]'
                      : 'hover:bg-[#e0e3e6]'
                  } transition`}
                  style={{ fontSize: 20 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedSession(chatSession);
                  }}
                />
              </div>
            )}
          </div>
        </Popover>
      </>
    );
  },
);

SessionBubble.displayName = 'SessionBubble';

const SiderContent = () => {
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [selectedModal, setSelectedModal] = useState<'edit' | 'delete'>('edit');
  const [selectedSession, setSelectedSession] = useState<ChatSessionType | null>(null);
  const [renameValue, setRenameValue] = useState<string>(selectedSession?.title || '');
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const { user } = useAuth();

  const { intialChatSessions, updateChatSession, chatSessions, setCurrentSessionId } =
    useConversationStore();

  const checkDifferentDay = (session: ChatSessionType, index: number) => {
    const showDate = formatYmd(session.updated_at);
    const lastDate = index > 0 ? formatYmd(chatSessions[index - 1].updated_at) : undefined;
    return index === 0 || showDate !== lastDate;
  };

  // 点击开启新对话：仅切到空对话视图（currentSessionId=''），store 会清空当前投影，
  // 不触碰其它正在后台运行的对话桶。
  const handleCreateNewSession = useCallback(() => {
    setCurrentSessionId('');
  }, [setCurrentSessionId]);

  // 点击编辑session
  const handleSelectEditSession = useCallback(
    (chatSession: ChatSessionType) => {
      if (chatSession.id === selectedSession?.id) {
        setSelectedSession(null);
      } else {
        setSelectedSession(chatSession);
      }
    },
    [selectedSession?.id],
  );

  // 编辑session操作确定
  const handleModalOk = async () => {
    if (!selectedSession) return;
    if (selectedModal === 'edit') {
      await apiClient
        .post('/conversations/update_session', {
          sessionId: selectedSession?.id,
          title: renameValue,
        })
        .then(() => {
          const updateSession: ChatSessionType = {
            ...selectedSession,
            title: renameValue,
            updated_at: Date.now(),
          };
          updateChatSession(updateSession, 'edit');
        });
    } else {
      await apiClient
        .delete('/conversations/update_session', {
          body: JSON.stringify({ sessionId: selectedSession?.id }),
        })
        .then(() => {
          updateChatSession(selectedSession, 'delete');
        });
    }

    setIsModalOpen(false);
    setSelectedSession(null);
  };

  // 初始化session列表
  useEffect(() => {
    const fetchSessions = async () => {
      const response = await getConversationSessions();
      intialChatSessions(response.data || []);
    };

    fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // session 编辑 popover 监听：仅在 selected 且 modal 关闭时挂监听
  useOutsideClick(!!selectedSession && !isModalOpen, () => {
    setSelectedSession(null);
  });

  useEffect(() => {
    if (selectedSession) {
      setRenameValue(selectedSession.title);
    }
  }, [selectedSession]);

  return (
    <div className="flex h-full w-full flex-col items-center gap-6">
      <div
        className="flex h-10 w-[92%] cursor-pointer items-center justify-center gap-2 rounded-2xl border border-[#e5e7eb] bg-white font-medium text-gray-700 shadow-[0px_1px_2px_rgba(16,24,40,0.05)] transition-all hover:border-teal-300 hover:text-teal-700 hover:shadow-[0_4px_12px_rgba(16,24,40,0.08)]"
        onClick={() => handleCreateNewSession()}
      >
        <PlusCircleOutlined style={{ color: '#0f766e', fontSize: 18 }} />
        开启新对话
      </div>
      <div className="scrollbar-hide flex min-h-0 w-[92%] flex-1 flex-col overflow-y-scroll">
        {chatSessions.map((session, index) => (
          <SessionBubble
            key={index}
            chatSession={session}
            isShowDate={checkDifferentDay(session, index)}
            isModalOpen={isModalOpen}
            selectedSession={selectedSession}
            setSelectedSession={handleSelectEditSession}
            setIsModalOpen={setIsModalOpen}
            setSelectedModal={setSelectedModal}
          />
        ))}
      </div>

      <div
        className="mb-3 flex h-11 w-[92%] cursor-pointer items-center gap-2 rounded-xl px-3 text-[#374151] transition-colors hover:bg-[#eef0f2]"
        onClick={() => setSettingsOpen(true)}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#d7f2f0] text-[13px] font-semibold text-[#0f766e]">
          {(user?.email?.[0] ?? 'U').toUpperCase()}
        </div>
        <span className="flex-1 overflow-hidden text-[13px] text-ellipsis whitespace-nowrap">
          {user?.email ?? '未登录'}
        </span>
        <SettingOutlined style={{ color: '#9ca3af', fontSize: 16 }} />
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <Modal
        title={selectedModal === 'edit' ? '重命名' : '删除对话'}
        open={isModalOpen}
        onCancel={() => setIsModalOpen(false)}
        onOk={() => handleModalOk()}
        centered
      >
        {selectedModal === 'edit' && (
          <textarea
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            rows={1}
            className="scrollbar-hide w-full resize-none overflow-y-auto rounded-xl border-2 border-sky-100 px-3 py-2 focus:outline-none"
          ></textarea>
        )}
        {selectedModal === 'delete' && (
          <div className="font-serif text-2xl text-red-500">确定要删除对话吗🤕</div>
        )}
      </Modal>
    </div>
  );
};

export default SiderContent;
