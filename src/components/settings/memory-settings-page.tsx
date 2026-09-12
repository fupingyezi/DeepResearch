'use client';

import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Empty, Input, Popconfirm, Segmented, Select, Spin, Tag, message } from 'antd';
import { useEffect, useMemo, useState } from 'react';

import apiClient from '@/utils/request/api';
import { useMemoryModeStore, type MemoryMode } from '@/store';

type FactCategory = 'preference' | 'knowledge' | 'context' | 'behavior' | 'goal' | 'correction';

interface Fact {
  id: string;
  content: string;
  category: FactCategory;
  confidence: number;
  createdAt: string;
  source: string;
}

interface SectionData {
  summary: string;
  updatedAt: string;
}

interface MemoryData {
  version: string;
  lastUpdated: string;
  user: { workContext: SectionData; personalContext: SectionData; topOfMind: SectionData };
  history: {
    recentMonths: SectionData;
    earlierContext: SectionData;
    longTermBackground: SectionData;
  };
  facts: Fact[];
}

const CATEGORY_LABEL: Record<FactCategory, string> = {
  preference: '偏好',
  knowledge: '知识',
  context: '背景',
  behavior: '行为',
  goal: '目标',
  correction: '纠正',
};

const CATEGORY_COLOR: Record<FactCategory, string> = {
  preference: 'cyan',
  knowledge: 'blue',
  context: 'default',
  behavior: 'purple',
  goal: 'green',
  correction: 'red',
};

const CATEGORY_OPTIONS = (Object.keys(CATEGORY_LABEL) as FactCategory[]).map((key) => ({
  value: key,
  label: CATEGORY_LABEL[key],
}));

const SECTION_LABELS: Array<{ group: 'user' | 'history'; key: string; label: string }> = [
  { group: 'user', key: 'workContext', label: '工作背景' },
  { group: 'user', key: 'personalContext', label: '个人背景' },
  { group: 'user', key: 'topOfMind', label: '近期关注' },
  { group: 'history', key: 'recentMonths', label: '近几个月' },
  { group: 'history', key: 'earlierContext', label: '更早记录' },
  { group: 'history', key: 'longTermBackground', label: '长期背景' },
];

function formatSource(source: string): string {
  if (source === 'manual') return '手动添加';
  if (source === 'unknown' || !source) return '自动整理';
  return '对话生成';
}

function formatTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 设置弹窗「记忆」页：展示模型沉淀的结构化记忆（只读 summary）与可增删改的 facts 列表。
 * 数据按当前登录用户隔离，通过 /api/memory 系列接口读写。
 */
export function MemorySettingsPage() {
  const [data, setData] = useState<MemoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [newContent, setNewContent] = useState('');
  const [newCategory, setNewCategory] = useState<FactCategory>('context');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState<FactCategory>('context');

  // 注入模式：服务端（users.memory_mode）为准，挂载时同步一次
  const memoryMode = useMemoryModeStore((s) => s.mode);
  const setMemoryModeLocal = useMemoryModeStore((s) => s.setMode);
  const [modeSaving, setModeSaving] = useState(false);

  const handleMemoryModeChange = async (next: MemoryMode) => {
    if (next === memoryMode || modeSaving) return;
    setModeSaving(true);
    try {
      await apiClient.put('/memory/mode', { mode: next });
      setMemoryModeLocal(next); // 成功后才更新本地，失败保持原值
      message.success(next === 'retrieve' ? '已切换为按需检索' : '已切换为全量注入');
    } catch {
      message.error('切换失败，请重试');
    } finally {
      setModeSaving(false);
    }
  };

  useEffect(() => {
    void useMemoryModeStore.getState().load();
  }, []);

  useEffect(() => {
    let active = true;
    apiClient
      .get('/memory')
      .then((res) => {
        if (active) setData(res.data);
      })
      .catch(() => message.error('加载记忆失败'))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const sections = useMemo(() => {
    if (!data) return [];
    return SECTION_LABELS.map((s) => ({
      label: s.label,
      // data[s.group] 是 user / history 两类对象的联合，二者的值均为 SectionData，
      // 按 key 动态取值需收窄为 Record<string, SectionData>。
      summary: (data[s.group] as Record<string, SectionData>)[s.key].summary,
    })).filter((s) => s.summary.trim().length > 0);
  }, [data]);

  const handleCreate = async () => {
    const content = newContent.trim();
    if (!content) return;
    setSubmitting(true);
    try {
      const res = await apiClient.post('/memory/facts', { content, category: newCategory });
      setData(res.data);
      setNewContent('');
      setNewCategory('context');
      message.success('已添加');
    } catch {
      message.error('添加失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await apiClient.delete(`/memory/facts/${id}`);
      setData(res.data);
      message.success('已删除');
    } catch {
      message.error('删除失败');
    }
  };

  const startEdit = (fact: Fact) => {
    setEditingId(fact.id);
    setEditContent(fact.content);
    setEditCategory(fact.category);
  };

  const handleUpdate = async () => {
    if (!editingId) return;
    const content = editContent.trim();
    if (!content) return;
    setSubmitting(true);
    try {
      const res = await apiClient.put(`/memory/facts/${editingId}`, {
        content,
        category: editCategory,
      });
      setData(res.data);
      setEditingId(null);
      message.success('已更新');
    } catch {
      message.error('更新失败');
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

  const facts = data?.facts ?? [];

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="mb-1 text-[18px] font-semibold text-[#111827]">记忆</h2>
        <p className="text-[13px] text-[#9ca3af]">
          系统会从你的对话中沉淀长期记忆，用于个性化研究。你也可以手动管理记忆条目。
        </p>
      </div>

      <section>
        <h3 className="mb-3 text-[15px] font-medium text-[#111827]">注入模式</h3>
        <div className="rounded-lg border border-[#e5e7eb] p-3">
          <Segmented<MemoryMode>
            value={memoryMode}
            disabled={modeSaving}
            onChange={handleMemoryModeChange}
            options={[
              { label: '全量注入', value: 'inject' },
              { label: '按需检索', value: 'retrieve' },
            ]}
          />
          <p className="mt-2 text-[12px] leading-relaxed text-[#9ca3af]">
            {memoryMode === 'retrieve'
              ? '按本轮提问检索最相关的记忆条目再注入（语义 + 关键词混合排序），注入内容更少、更聚焦；没有相关记忆时不注入。'
              : '把全部记忆（画像摘要 + 所有条目）注入每轮对话，信息最全，但占用更多上下文。'}
          </p>
        </div>
      </section>

      {sections.length > 0 && (
        <section>
          <h3 className="mb-3 text-[15px] font-medium text-[#111827]">背景画像</h3>
          <div className="flex flex-col gap-3">
            {sections.map((s) => (
              <div key={s.label} className="rounded-lg border border-[#e5e7eb] bg-[#f9fafb] p-3">
                <div className="mb-1 text-[13px] font-medium text-[#0f766e]">{s.label}</div>
                <div className="text-[13px] leading-relaxed text-[#374151]">{s.summary}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-3 text-[15px] font-medium text-[#111827]">记忆条目（{facts.length}）</h3>

        <div className="mb-4 flex flex-col gap-2 rounded-lg border border-[#e5e7eb] p-3">
          <Input.TextArea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="添加一条记忆，例如：偏好用中文回答、关注新能源行业……"
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
          <div className="flex items-center justify-between">
            <Select
              value={newCategory}
              onChange={setNewCategory}
              options={CATEGORY_OPTIONS}
              size="small"
              style={{ width: 110 }}
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={handleCreate}
              loading={submitting}
              disabled={!newContent.trim()}
              style={{ background: '#0f766e' }}
            >
              添加
            </Button>
          </div>
        </div>

        {facts.length === 0 ? (
          <Empty description="暂无记忆条目" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div className="flex flex-col gap-2">
            {facts.map((fact) => (
              <div
                key={fact.id}
                className="group rounded-lg border border-[#e5e7eb] p-3 transition-colors hover:border-[#14b8a6]"
              >
                {editingId === fact.id ? (
                  <div className="flex flex-col gap-2">
                    <Input.TextArea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      autoSize={{ minRows: 2, maxRows: 4 }}
                    />
                    <div className="flex items-center justify-between">
                      <Select
                        value={editCategory}
                        onChange={setEditCategory}
                        options={CATEGORY_OPTIONS}
                        size="small"
                        style={{ width: 110 }}
                      />
                      <div className="flex gap-2">
                        <Button size="small" onClick={() => setEditingId(null)}>
                          取消
                        </Button>
                        <Button
                          size="small"
                          type="primary"
                          onClick={handleUpdate}
                          loading={submitting}
                          style={{ background: '#0f766e' }}
                        >
                          保存
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="text-[13px] leading-relaxed text-[#374151]">
                        {fact.content}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[#9ca3af]">
                        <Tag color={CATEGORY_COLOR[fact.category]} style={{ margin: 0 }}>
                          {CATEGORY_LABEL[fact.category] ?? fact.category}
                        </Tag>
                        <span>置信度 {Math.round(fact.confidence * 100)}%</span>
                        <span>·</span>
                        <span>{formatSource(fact.source)}</span>
                        {formatTime(fact.createdAt) && (
                          <>
                            <span>·</span>
                            <span>{formatTime(fact.createdAt)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <Button
                        type="text"
                        size="small"
                        icon={<EditOutlined />}
                        onClick={() => startEdit(fact)}
                      />
                      <Popconfirm
                        title="删除这条记忆？"
                        onConfirm={() => handleDelete(fact.id)}
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                      >
                        <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
