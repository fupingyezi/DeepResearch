'use client';

import { CheckCircleFilled, GlobalOutlined, RobotOutlined } from '@ant-design/icons';
import { Empty, Spin, Tag, message } from 'antd';
import { useEffect, useState } from 'react';

import apiClient from '@/utils/request/api';
import { McpServersSection } from './mcp-servers-section';

type ToolCategory = 'builtin' | 'agent';

interface ToolInfo {
  name: string;
  displayName: string;
  description: string;
  category: ToolCategory;
  enabled: boolean;
}

const CATEGORY_META: Record<ToolCategory, { label: string; color: string }> = {
  builtin: { label: '内置工具', color: 'cyan' },
  agent: { label: '智能体工具', color: 'purple' },
};

function ToolIcon({ category }: { category: ToolCategory }) {
  return category === 'builtin' ? (
    <GlobalOutlined className="text-[#0f766e]" />
  ) : (
    <RobotOutlined className="text-[#7c3aed]" />
  );
}

/**
 * 设置弹窗「工具」页：展示研究智能体真实注册的工具（联网搜索、任务委派、澄清提问等），
 * 工具为核心研究链路依赖，默认全部启用、暂不支持禁用。下方 MCP 服务区支持接入外部
 * MCP 服务器以扩展工具能力。
 */
export function ToolsSettingsPage() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    apiClient
      .get('/tools')
      .then((res) => {
        if (active) setTools(res.data ?? []);
      })
      .catch(() => message.error('加载工具失败'))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spin />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="mb-1 text-[18px] font-semibold text-[#111827]">工具</h2>
        <p className="text-[13px] text-[#9ca3af]">
          研究智能体在执行任务时可调用的能力。以下工具为核心研究链路依赖，默认全部启用。
        </p>
      </div>

      <section>
        <h3 className="mb-3 text-[15px] font-medium text-[#111827]">
          已启用工具（{tools.length}）
        </h3>
        {tools.length === 0 ? (
          <Empty description="暂无可用工具" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div className="flex flex-col gap-2">
            {tools.map((tool) => (
              <div
                key={tool.name}
                className="flex items-start gap-3 rounded-lg border border-[#e5e7eb] p-3"
              >
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#f3f4f6] text-[16px]">
                  <ToolIcon category={tool.category} />
                </div>
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium text-[#111827]">
                      {tool.displayName}
                    </span>
                    <span className="font-mono text-[12px] text-[#9ca3af]">{tool.name}</span>
                    <Tag color={CATEGORY_META[tool.category].color} style={{ margin: 0 }}>
                      {CATEGORY_META[tool.category].label}
                    </Tag>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-[#6b7280]">
                    {tool.description || '暂无描述'}
                  </p>
                </div>
                <div className="mt-0.5 flex shrink-0 items-center gap-1 text-[12px] text-[#0f766e]">
                  <CheckCircleFilled />
                  <span>已启用</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <McpServersSection />
    </div>
  );
}
