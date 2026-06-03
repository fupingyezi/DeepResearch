'use client';

import {
  UserOutlined,
  BgColorsOutlined,
  BellOutlined,
  DatabaseOutlined,
  ToolOutlined,
  ApiOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { Modal } from 'antd';
import { useState } from 'react';

import { AccountSettingsPage } from './account-settings-page';
import { PlaceholderPage } from './placeholder-page';

type TabKey = 'account' | 'appearance' | 'notification' | 'memory' | 'tools' | 'skills' | 'about';

interface TabItem {
  key: TabKey;
  label: string;
  icon: React.ReactNode;
}

const TABS: TabItem[] = [
  { key: 'account', label: '账号', icon: <UserOutlined /> },
  { key: 'appearance', label: '外观', icon: <BgColorsOutlined /> },
  { key: 'notification', label: '通知', icon: <BellOutlined /> },
  { key: 'memory', label: '记忆', icon: <DatabaseOutlined /> },
  { key: 'tools', label: '工具', icon: <ToolOutlined /> },
  { key: 'skills', label: '技能', icon: <ApiOutlined /> },
  { key: 'about', label: '关于', icon: <InfoCircleOutlined /> },
];

/**
 * 设置弹窗：左侧竖向菜单 + 右侧内容区。
 * 账号页已实现，其余 Tab 为占位空态。
 */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [active, setActive] = useState<TabKey>('account');

  const activeLabel = TABS.find((t) => t.key === active)?.label ?? '';

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      centered
      width={880}
      styles={{ body: { padding: 0 } }}
      title={null}
    >
      <div className="flex h-[560px]">
        <div className="flex w-[200px] shrink-0 flex-col gap-1 border-r border-[#e5e7eb] bg-[#f9fafb] p-3">
          <div className="mb-2 px-2 pt-1 text-[16px] font-semibold text-[#111827]">设置</div>
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActive(tab.key)}
              className={`flex h-9 cursor-pointer items-center gap-2 rounded-lg px-3 text-[14px] transition-colors ${
                active === tab.key
                  ? 'bg-[#d7f2f0] font-medium text-[#0f766e]'
                  : 'text-[#374151] hover:bg-[#eef0f2]'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-8">
          {active === 'account' ? <AccountSettingsPage /> : <PlaceholderPage title={activeLabel} />}
        </div>
      </div>
    </Modal>
  );
}
