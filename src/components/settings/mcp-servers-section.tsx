'use client';

import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Empty, Input, Modal, Popconfirm, Select, Spin, Switch, Tag, message } from 'antd';
import { useEffect, useState } from 'react';

import apiClient from '@/utils/request/api';

type McpTransport = 'stdio' | 'sse' | 'http';

interface McpServerConfig {
  enabled: boolean;
  type: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
}

interface McpServerEntry {
  name: string;
  config: McpServerConfig;
}

interface EditState {
  name: string;
  isNew: boolean;
  type: McpTransport;
  description: string;
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
}

const TRANSPORT_OPTIONS = [
  { value: 'stdio', label: 'stdio（本地命令）' },
  { value: 'sse', label: 'sse（远程）' },
  { value: 'http', label: 'http（远程）' },
];

function emptyEditState(): EditState {
  return {
    name: '',
    isNew: true,
    type: 'stdio',
    description: '',
    command: '',
    argsText: '',
    envText: '',
    url: '',
    headersText: '',
  };
}

function toEditState(name: string, config: McpServerConfig): EditState {
  return {
    name,
    isNew: false,
    type: config.type,
    description: config.description ?? '',
    command: config.command ?? '',
    argsText: (config.args ?? []).join('\n'),
    envText: kvToText(config.env),
    url: config.url ?? '',
    headersText: kvToText(config.headers),
  };
}

function kvToText(obj?: Record<string, string>): string {
  if (!obj) return '';
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** 把 "KEY=VALUE" 多行文本解析为对象（忽略空行与无等号行）。 */
function textToKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

function buildConfigFromEdit(state: EditState): McpServerConfig {
  const base: McpServerConfig = {
    enabled: true,
    type: state.type,
    description: state.description.trim(),
  };
  if (state.type === 'stdio') {
    base.command = state.command.trim();
    base.args = state.argsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    base.env = textToKv(state.envText);
  } else {
    base.url = state.url.trim();
    base.headers = textToKv(state.headersText);
  }
  return base;
}

/**
 * MCP 服务器管理区：列表 + 启用开关 + 新增/编辑/删除。
 * 通过 /api/mcp 系列接口读写 extensions_config.json。
 */
export function McpServersSection() {
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingName, setTogglingName] = useState<string | null>(null);

  const [edit, setEdit] = useState<EditState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = () => {
    setLoading(true);
    apiClient
      .get('/mcp')
      .then((res) => {
        const map = (res.data?.mcpServers ?? {}) as Record<string, McpServerConfig>;
        setServers(
          Object.entries(map)
            .map(([name, config]) => ({ name, config }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      })
      .catch(() => message.error('加载 MCP 配置失败'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleToggle = async (name: string, enabled: boolean) => {
    setTogglingName(name);
    try {
      await apiClient.patch(`/mcp/${encodeURIComponent(name)}`, { enabled });
      setServers((prev) =>
        prev.map((s) => (s.name === name ? { ...s, config: { ...s.config, enabled } } : s)),
      );
    } catch {
      message.error('更新失败');
    } finally {
      setTogglingName(null);
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await apiClient.delete(`/mcp/${encodeURIComponent(name)}`);
      setServers((prev) => prev.filter((s) => s.name !== name));
      message.success('已删除');
    } catch {
      message.error('删除失败');
    }
  };

  const handleSave = async () => {
    if (!edit) return;
    const name = edit.name.trim();
    if (!name) {
      message.error('请填写服务器名称');
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post('/mcp', { name, config: buildConfigFromEdit(edit) });
      message.success('已保存');
      setEdit(null);
      refresh();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[15px] font-medium text-[#111827]">MCP 服务</h3>
        <Button
          size="small"
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setEdit(emptyEditState())}
          style={{ background: '#0f766e' }}
        >
          新增服务器
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-6">
          <Spin />
        </div>
      ) : servers.length === 0 ? (
        <Empty
          description="暂无 MCP 服务器，点击右上角新增以扩展工具能力"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {servers.map(({ name, config }) => (
            <div
              key={name}
              className="group flex items-start gap-3 rounded-lg border border-[#e5e7eb] p-3"
            >
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-medium text-[#111827]">{name}</span>
                  <Tag color="geekblue" style={{ margin: 0 }}>
                    {config.type}
                  </Tag>
                </div>
                <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-[#6b7280]">
                  {config.description ||
                    (config.type === 'stdio' ? config.command : config.url) ||
                    '暂无描述'}
                </p>
              </div>
              <div className="mt-0.5 flex shrink-0 items-center gap-1">
                <Switch
                  checked={config.enabled}
                  loading={togglingName === name}
                  onChange={(checked) => handleToggle(name, checked)}
                />
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => setEdit(toEditState(name, config))}
                />
                <Popconfirm
                  title={`删除服务器「${name}」？`}
                  onConfirm={() => handleDelete(name)}
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                >
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={edit !== null}
        title={edit?.isNew ? '新增 MCP 服务器' : `编辑「${edit?.name}」`}
        onCancel={() => setEdit(null)}
        onOk={handleSave}
        okText="保存"
        cancelText="取消"
        confirmLoading={submitting}
        okButtonProps={{ style: { background: '#0f766e' } }}
        width={640}
      >
        {edit && (
          <div className="flex flex-col gap-3 pt-2">
            <div>
              <div className="mb-1 text-[13px] text-[#374151]">服务器名称</div>
              <Input
                value={edit.name}
                disabled={!edit.isNew}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                placeholder="例如：filesystem"
              />
            </div>
            <div>
              <div className="mb-1 text-[13px] text-[#374151]">传输类型</div>
              <Select
                value={edit.type}
                onChange={(value) => setEdit({ ...edit, type: value })}
                options={TRANSPORT_OPTIONS}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <div className="mb-1 text-[13px] text-[#374151]">描述</div>
              <Input
                value={edit.description}
                onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                placeholder="这个服务器提供什么能力"
              />
            </div>

            {edit.type === 'stdio' ? (
              <>
                <div>
                  <div className="mb-1 text-[13px] text-[#374151]">启动命令</div>
                  <Input
                    value={edit.command}
                    onChange={(e) => setEdit({ ...edit, command: e.target.value })}
                    placeholder="例如：npx"
                  />
                </div>
                <div>
                  <div className="mb-1 text-[13px] text-[#374151]">参数（每行一个）</div>
                  <Input.TextArea
                    value={edit.argsText}
                    onChange={(e) => setEdit({ ...edit, argsText: e.target.value })}
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path'}
                  />
                </div>
                <div>
                  <div className="mb-1 text-[13px] text-[#374151]">
                    环境变量（每行 KEY=VALUE，支持 $VAR）
                  </div>
                  <Input.TextArea
                    value={edit.envText}
                    onChange={(e) => setEdit({ ...edit, envText: e.target.value })}
                    autoSize={{ minRows: 1, maxRows: 6 }}
                    placeholder="GITHUB_TOKEN=$GITHUB_TOKEN"
                  />
                </div>
              </>
            ) : (
              <>
                <div>
                  <div className="mb-1 text-[13px] text-[#374151]">服务器 URL</div>
                  <Input
                    value={edit.url}
                    onChange={(e) => setEdit({ ...edit, url: e.target.value })}
                    placeholder="https://example.com/mcp"
                  />
                </div>
                <div>
                  <div className="mb-1 text-[13px] text-[#374151]">
                    请求头（每行 KEY=VALUE，支持 $VAR）
                  </div>
                  <Input.TextArea
                    value={edit.headersText}
                    onChange={(e) => setEdit({ ...edit, headersText: e.target.value })}
                    autoSize={{ minRows: 1, maxRows: 6 }}
                    placeholder="Authorization=Bearer $API_TOKEN"
                  />
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </section>
  );
}
