'use client';

import {
  PlusCircleOutlined,
  EllipsisOutlined,
  EditOutlined,
  DeleteOutlined,
  SettingOutlined,
  LoadingOutlined,
  ExclamationCircleFilled,
} from '@ant-design/icons';
import { ConfigProvider, Input, Modal, Popover, message } from 'antd';

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

type SessionDialogMode = 'rename' | 'delete';

interface SessionBubbleProps {
  chatSession: ChatSessionType;
  isShowDate: boolean;
  /** 当前展开「⋯ 菜单」的会话（同时只有一个是打开的） */
  selectedSession: ChatSessionType | null;
  setSelectedSession: (selectedSession: ChatSessionType | null) => void;
  /** 打开重命名 / 删除弹窗（弹窗自己持有目标会话，不依赖 selectedSession） */
  onRequestAction: (mode: SessionDialogMode, session: ChatSessionType) => void;
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
  ({ chatSession, isShowDate = false, selectedSession, setSelectedSession, onRequestAction }) => {
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
                onClick={() => onRequestAction('rename', chatSession)}
              >
                <EditOutlined />
                重命名
              </div>
              <div
                className="flex items-center gap-2 rounded-md px-2 py-1 text-red-600 hover:cursor-pointer hover:bg-gray-100"
                onClick={() => onRequestAction('delete', chatSession)}
              >
                <DeleteOutlined /> 删除此对话
              </div>
            </div>
          }
          placement="right"
          open={selectedSession?.id === chatSession.id}
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
                    setSelectedSession(selectedSession?.id === chatSession.id ? null : chatSession);
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
  const [selectedSession, setSelectedSession] = useState<ChatSessionType | null>(null);
  // 弹窗目标状态与 selectedSession（Popover 开合态）**必须**分开存：
  // useOutsideClick 在 document 上挂 click 监听，会清空 selectedSession，而
  // Next App Router 把 React root 挂载在 document 上（next/dist/client/app-index.js
  // 里 `const appElement = document`），Popover 菜单项里的 e.stopPropagation() 属于
  // 同节点监听器、拦不住它 —— 点「删除此对话」的那一次 click 会先把 selectedSession
  // 清成 null，弹窗虽能打开，点确定时却因「没有目标」直接 return，请求根本发不出去。
  const [dialog, setDialog] = useState<{
    mode: SessionDialogMode;
    session: ChatSessionType;
  } | null>(null);
  const [renameValue, setRenameValue] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
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

  // Popover 菜单项 → 打开弹窗。显式收起 Popover，不依赖 document 监听那次清空。
  const handleRequestAction = useCallback((mode: SessionDialogMode, session: ChatSessionType) => {
    setSelectedSession(null);
    setRenameValue(session.title);
    setDialog({ mode, session });
  }, []);

  const closeDialog = () => {
    if (submitting) return; // 提交中不许关闭，避免结果落空／重复提交
    setDialog(null);
  };

  // 弹窗确认：重命名 / 删除
  const handleDialogOk = async () => {
    if (!dialog || submitting) return;
    const { mode, session } = dialog;
    const title = renameValue.trim();

    if (mode === 'rename' && !title) {
      message.warning('对话名称不能为空');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'rename') {
        await apiClient.post('/conversations/update_session', { sessionId: session.id, title });
        updateChatSession({ ...session, title, updated_at: Date.now() }, 'edit');
      } else {
        await apiClient.delete('/conversations/update_session', {
          body: JSON.stringify({ sessionId: session.id }),
        });
        updateChatSession(session, 'delete');
        message.success('对话已删除');
      }
      setDialog(null);
    } catch (error) {
      // 此前这条链路完全没有错误处理：请求失败时弹窗既不关也不提示，看起来就像
      // 「点了没反应」。失败必须让用户看见。
      console.error(`${mode} session failed:`, error);
      message.error(mode === 'rename' ? '重命名失败，请稍后重试' : '删除失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
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

  // 点空白处收起「⋯ 菜单」。弹窗目标已独立存放，这里清空不会波及弹窗。
  useOutsideClick(!!selectedSession, () => {
    setSelectedSession(null);
  });

  // 高度约束用 flex-1 + min-h-0，**不要**改回 h-full：
  // 本组件是 sider.tsx 里 h-screen 列容器的第二个子项（上面还有一行 logo），
  // h-full 会解析成整屏高 → 整体比容器高出一个 logo 的高度，底部（用户设置入口，
  // h-11 + mb-3 = 56px）落到视口外；而 body 是 overflow-hidden，被裁掉的部分滚动
  // 也够不到。会话列表越长越明显（min-height:auto 阻止 flex 压缩）。
  // flex-1 取「剩余空间」，min-h-0 允许收缩，内层列表才能真正内部滚动。
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-6">
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
            key={String(session.id)}
            chatSession={session}
            isShowDate={checkDifferentDay(session, index)}
            selectedSession={selectedSession}
            setSelectedSession={setSelectedSession}
            onRequestAction={handleRequestAction}
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

      {/* 局部 ConfigProvider：只给这两个弹窗换圆角与主色（对齐侧栏 teal 设计语言），
          不引入全局主题，设置页等处的 antd 弹窗保持原样。 */}
      <ConfigProvider theme={{ token: { borderRadiusLG: 16, colorPrimary: '#0f766e' } }}>
        {/* 删除确认：破坏性操作 —— 说清「不可恢复」+ 回显是哪一条，按钮用 danger 红 */}
        <Modal
          open={dialog?.mode === 'delete'}
          onCancel={closeDialog}
          onOk={handleDialogOk}
          title={
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-red-50">
                <ExclamationCircleFilled className="text-[15px] text-red-500" />
              </span>
              <span className="text-[15px] font-semibold text-[#111827]">删除对话</span>
            </div>
          }
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          cancelButtonProps={{ disabled: submitting }}
          confirmLoading={submitting}
          maskClosable={false}
          centered
          width={400}
        >
          <div className="space-y-3 pt-1">
            <p className="m-0 text-[13px] leading-6 text-[#4b5563]">
              删除后，该对话的消息与文件记录将无法恢复。
            </p>
            {dialog && dialog.mode === 'delete' && (
              <div className="truncate rounded-xl bg-[#f3f4f6] px-3 py-2 text-[13px] text-[#374151]">
                {dialog.session.title}
              </div>
            )}
          </div>
        </Modal>

        {/* 重命名：输入框 + 回车即提交 */}
        <Modal
          open={dialog?.mode === 'rename'}
          onCancel={closeDialog}
          onOk={handleDialogOk}
          title={<span className="text-[15px] font-semibold text-[#111827]">重命名对话</span>}
          okText="保存"
          cancelText="取消"
          cancelButtonProps={{ disabled: submitting }}
          confirmLoading={submitting}
          maskClosable={false}
          centered
          width={400}
        >
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onPressEnter={handleDialogOk}
            maxLength={60}
            autoFocus
            placeholder="请输入对话名称"
            className="mt-1"
          />
        </Modal>
      </ConfigProvider>
    </div>
  );
};

export default SiderContent;
