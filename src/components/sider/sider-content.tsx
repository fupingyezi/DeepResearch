'use client';

import {
  PlusCircleOutlined,
  EllipsisOutlined,
  EditOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { Popover, Modal } from 'antd';

import { useCallback, useEffect, useState } from 'react';
import React from 'react';
import { ChatSessionType } from '@/types';
import apiClient from '@/utils/request/api';
import { useConversationStore } from '@/store';
import { UUIDTypes, v4 as uuidv4 } from 'uuid';

async function getConversationSessions() {
  try {
    const data = await apiClient.get('/conversations/get_all_sessions');
    return data;
  } catch (error) {
    console.error('Failed to fetch conversation sessions:', error);
    return { data: [] };
  }
}

const SessionBubble: React.FC<{
  chatSession: ChatSessionType;
  isShowDate: boolean;
  selectedSession: ChatSessionType | null;
  isModalOpen: boolean;
  setSelectedSession: (selectedSession: ChatSessionType) => void;
  setIsModalOpen: (isModalOpen: boolean) => void;
  setSelectedModal: (selectedModal: 'edit' | 'delete') => void;
}> = React.memo(
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

    const { currentSessionId, setCurrentSessionId, setCurrentMessages } = useConversationStore();
    const date = new Date(chatSession.updated_at);
    const showDate = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

    const handleSelectSession = async (sessionId: UUIDTypes) => {
      setCurrentSessionId(sessionId);
      try {
        const response = await apiClient.post('/conversations/get_current_messages', { sessionId });
        // console.log(response.data);
        setCurrentMessages(response.data);
      } catch (error) {
        console.error('error:', error);
      }
    };

    return (
      <>
        {isShowDate && <div className="w-full px-3 text-[12px] text-[#81858c]">{showDate}</div>}
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
            className="relative min-h-10 w-full overflow-hidden rounded-2xl px-3 leading-10 text-ellipsis whitespace-nowrap hover:cursor-pointer hover:bg-[#ebedef]"
            style={{
              backgroundColor: chatSession.id === currentSessionId ? '#e4ecfc' : '',
              color: chatSession.id === currentSessionId ? 'blue' : '',
            }}
            onMouseEnter={() => setIsHover(true)}
            onMouseLeave={() => setIsHover(false)}
            onClick={() => handleSelectSession(chatSession.id)}
          >
            {chatSession.title}
            {isHover && (
              <div
                className={`absolute top-1/2 right-0 flex h-full w-9 -translate-y-1/2 transform items-center justify-center ${
                  chatSession.id === currentSessionId ? 'bg-[#e4ecfc]' : 'bg-[#ebedef]'
                }`}
              >
                <EllipsisOutlined
                  className={`h-6 w-6 rounded-4xl p-0.5 ${
                    chatSession.id === currentSessionId
                      ? 'hover:bg-[#d9e3f3]'
                      : 'hover:bg-[#e5e8eb]'
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

const SiderContent = () => {
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [selectedModal, setSelectedModal] = useState<'edit' | 'delete'>('edit');
  const [selectedSession, setSelectedSession] = useState<ChatSessionType | null>(null);
  const [renameValue, setRenameValue] = useState<string>(selectedSession?.title || '');

  const {
    intialChatSessions,
    updateChatSession,
    chatSessions,
    setCurrentSessionId,
    setCurrentMessages,
  } = useConversationStore();

  const checkDifferentDay = (session: ChatSessionType, index: number) => {
    const date = new Date(session.updated_at);
    const showDate = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    let lastDate;
    if (index > 0) {
      const date = new Date(chatSessions[index - 1].updated_at);
      lastDate = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    }

    return index === 0 || showDate !== lastDate;
  };

  // 点击开启新对话
  const handleCreateNewSession = useCallback(() => {
    setCurrentMessages([]);
    setCurrentSessionId('');
  }, [setCurrentMessages, setCurrentSessionId]);

  // 点击编辑session
  const handleSelectEditSession = useCallback(
    (chatSession: ChatSessionType) => {
      if (chatSession.id === selectedSession?.id) {
        setSelectedSession(null);
      } else {
        setSelectedSession(chatSession);
      }
    },
    [setSelectedSession],
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
  }, []);

  // session编辑popover监听
  useEffect(() => {
    if (!selectedSession || isModalOpen) return;

    const handleClick = () => {
      setSelectedSession(null);
    };

    document.addEventListener('click', handleClick);

    return () => {
      document.removeEventListener('click', handleClick);
    };
  }, [selectedSession, isModalOpen]);

  useEffect(() => {
    if (selectedSession) {
      setRenameValue(selectedSession.title);
    }
  }, [selectedSession]);

  return (
    <div className="flex h-full w-full flex-col items-center gap-6">
      <div
        className="flex h-10 w-[92%] cursor-pointer items-center justify-center gap-2 rounded-2xl border border-transparent bg-white shadow-[0px_-2px_2px_rgba(72,104,178,0.04),0px_2px_2px_rgba(106,111,117,0.09),0px_1px_2px_rgba(72,104,178,0.08)] hover:shadow-[0_4px_4px_rgba(72,104,178,0.04),0_-3px_4px_rgba(72,104,178,0.04),0_6px_6px_rgba(106,111,117,0.1)]"
        onClick={() => handleCreateNewSession()}
      >
        <PlusCircleOutlined style={{ color: 'black', fontSize: 20 }} />
        开启新对话
      </div>
      <div className="scrollbar-hide flex h-4/5 w-[92%] flex-col overflow-y-scroll">
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
