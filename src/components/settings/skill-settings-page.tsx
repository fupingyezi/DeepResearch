'use client';

import { ApiOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Empty, Input, Modal, Spin, Switch, Tag, message } from 'antd';
import { useEffect, useMemo, useState } from 'react';

import apiClient from '@/utils/request/api';

type SkillCategory = 'public' | 'custom';

interface Skill {
  name: string;
  description: string;
  category: SkillCategory;
  enabled: boolean;
}

const CATEGORY_META: Record<SkillCategory, { label: string; color: string }> = {
  public: { label: '内置', color: 'cyan' },
  custom: { label: '自定义', color: 'purple' },
};

const CUSTOM_SKILL_TEMPLATE = `---
name: my-skill
description: 描述这个技能的用途，以及在什么情况下应当使用它。
---

# My Skill

在这里写下技能的工作流与使用说明。
`;

/**
 * 设置弹窗「技能」页：分内置/自定义两组展示，每项含名称、描述与启用开关。
 * 启用的技能元数据会注入研究智能体的系统提示。支持新建自定义技能。
 */
export function SkillSettingsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingName, setTogglingName] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newContent, setNewContent] = useState(CUSTOM_SKILL_TEMPLATE);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    apiClient
      .get('/skills')
      .then((res) => {
        if (active) setSkills(res.data ?? []);
      })
      .catch(() => message.error('加载技能失败'))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const { publicSkills, customSkills } = useMemo(
    () => ({
      publicSkills: skills.filter((s) => s.category === 'public'),
      customSkills: skills.filter((s) => s.category === 'custom'),
    }),
    [skills],
  );

  const handleToggle = async (name: string, enabled: boolean) => {
    setTogglingName(name);
    try {
      await apiClient.patch(`/skills/${encodeURIComponent(name)}`, { enabled });
      setSkills((prev) => prev.map((s) => (s.name === name ? { ...s, enabled } : s)));
    } catch {
      message.error('更新失败');
    } finally {
      setTogglingName(null);
    }
  };

  const handleCreate = async () => {
    setSubmitting(true);
    try {
      const res = await apiClient.post('/skills', { name: newName.trim(), content: newContent });
      setSkills((prev) => [...prev, res.data].sort((a, b) => a.name.localeCompare(b.name)));
      setCreateOpen(false);
      setNewName('');
      setNewContent(CUSTOM_SKILL_TEMPLATE);
      message.success('已创建');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

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
        <h2 className="mb-1 text-[18px] font-semibold text-[#111827]">技能</h2>
        <p className="text-[13px] text-[#9ca3af]">
          技能（Skill）为研究智能体提供领域工作流。启用后，技能说明会注入智能体的系统提示，使其在匹配场景下据此行动。
        </p>
      </div>

      <SkillGroup
        title={`内置技能（${publicSkills.length}）`}
        skills={publicSkills}
        togglingName={togglingName}
        onToggle={handleToggle}
      />

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[15px] font-medium text-[#111827]">
            自定义技能（{customSkills.length}）
          </h3>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateOpen(true)}
            style={{ background: '#0f766e' }}
          >
            新建技能
          </Button>
        </div>
        <SkillList skills={customSkills} togglingName={togglingName} onToggle={handleToggle} />
      </section>

      <Modal
        open={createOpen}
        title="新建自定义技能"
        onCancel={() => setCreateOpen(false)}
        onOk={handleCreate}
        okText="创建"
        cancelText="取消"
        confirmLoading={submitting}
        okButtonProps={{ disabled: !newName.trim(), style: { background: '#0f766e' } }}
        width={640}
      >
        <div className="flex flex-col gap-3 pt-2">
          <div>
            <div className="mb-1 text-[13px] text-[#374151]">技能名称（小写字母/数字/连字符）</div>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="例如：market-research"
            />
          </div>
          <div>
            <div className="mb-1 text-[13px] text-[#374151]">SKILL.md 内容（含 frontmatter）</div>
            <Input.TextArea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              autoSize={{ minRows: 8, maxRows: 16 }}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
            <p className="mt-1 text-[12px] text-[#9ca3af]">
              frontmatter 的 name 必须与上方技能名称一致，且需包含 description。
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function SkillGroup({
  title,
  skills,
  togglingName,
  onToggle,
}: {
  title: string;
  skills: Skill[];
  togglingName: string | null;
  onToggle: (name: string, enabled: boolean) => void;
}) {
  return (
    <section>
      <h3 className="mb-3 text-[15px] font-medium text-[#111827]">{title}</h3>
      <SkillList skills={skills} togglingName={togglingName} onToggle={onToggle} />
    </section>
  );
}

function SkillList({
  skills,
  togglingName,
  onToggle,
}: {
  skills: Skill[];
  togglingName: string | null;
  onToggle: (name: string, enabled: boolean) => void;
}) {
  if (skills.length === 0) {
    return <Empty description="暂无技能" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <div className="flex flex-col gap-2">
      {skills.map((skill) => (
        <div
          key={skill.name}
          className="flex items-start gap-3 rounded-lg border border-[#e5e7eb] p-3"
        >
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#f3f4f6] text-[16px]">
            <ApiOutlined className="text-[#0f766e]" />
          </div>
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-medium text-[#111827]">{skill.name}</span>
              <Tag color={CATEGORY_META[skill.category].color} style={{ margin: 0 }}>
                {CATEGORY_META[skill.category].label}
              </Tag>
            </div>
            <p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-[#6b7280]">
              {skill.description || '暂无描述'}
            </p>
          </div>
          <div className="mt-0.5 shrink-0">
            <Switch
              checked={skill.enabled}
              loading={togglingName === skill.name}
              onChange={(checked) => onToggle(skill.name, checked)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
