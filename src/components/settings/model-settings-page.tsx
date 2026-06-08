'use client';

import { CheckCircleFilled, KeyOutlined } from '@ant-design/icons';
import { Spin, Tag, message } from 'antd';
import { useMemo, useState } from 'react';

import apiClient from '@/utils/request/api';
import { MODEL_PRESETS, getAvailablePresets, type ModelPresetName } from '@/config/models';
import { useModelConfigStatus } from '@/hooks';
import { useModelStore } from '@/store';

/** provider 展示名。 */
const PROVIDER_LABEL: Record<string, string> = {
  qwen: '阿里 Qwen',
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  moonshot: 'Moonshot (Kimi)',
};

const inputClass =
  'h-10 w-full rounded-lg border border-[#e5e7eb] bg-white px-3 text-[14px] outline-none transition-colors focus:border-[#14b8a6]';

/**
 * 设置弹窗「模型管理」页：
 * - 顶部：当前使用模型（仅可选已配置 Key 的模型）。
 * - 中部：按 provider 分组的预设模型卡片 + 每个 provider 的 Key 输入/保存/清除。
 * - API Key 加密存储且永不回显明文，仅展示掩码状态。
 */
export function ModelSettingsPage() {
  const { configured, selectedModel, loading, refresh } = useModelConfigStatus();
  const setLocalModel = useModelStore((s) => s.setModel);

  // 各 provider 输入框的临时明文（不进全局 store，提交后清空）。
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingProvider, setSavingProvider] = useState<string | null>(null);

  const presets = getAvailablePresets();

  // provider → 掩码（已配置）。
  const maskedByProvider = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of configured) map[c.provider] = c.masked;
    return map;
  }, [configured]);

  // 按 provider 分组预设，保持稳定顺序。
  const grouped = useMemo(() => {
    const order: string[] = [];
    const byProvider: Record<string, typeof presets> = {};
    for (const p of presets) {
      if (!byProvider[p.provider]) {
        byProvider[p.provider] = [];
        order.push(p.provider);
      }
      byProvider[p.provider].push(p);
    }
    return order.map((provider) => ({ provider, items: byProvider[provider] }));
  }, [presets]);

  const handleSaveKey = async (provider: string) => {
    const apiKey = (drafts[provider] ?? '').trim();
    if (!apiKey) {
      message.warning('请先粘贴 API Key');
      return;
    }
    setSavingProvider(provider);
    try {
      await apiClient.put('/model-keys', { provider, apiKey });
      // 若用户尚未设置当前模型，自动把该 provider 的首个预设设为当前，开箱即用。
      if (!selectedModel) {
        const firstPreset = presets.find((p) => p.provider === provider);
        if (firstPreset) {
          await apiClient
            .patch('/model-keys', { selectedModel: firstPreset.key })
            .then(() => setLocalModel(firstPreset.key))
            .catch((e) => console.error('[ModelSettingsPage] auto-select failed:', e));
        }
      }
      message.success(`${PROVIDER_LABEL[provider] ?? provider} 的 API Key 已保存`);
      setDrafts((prev) => ({ ...prev, [provider]: '' }));
      await refresh();
    } catch (e) {
      console.error('[ModelSettingsPage] save key failed:', e);
      message.error('保存失败，请重试');
    } finally {
      setSavingProvider(null);
    }
  };

  const handleClearKey = async (provider: string) => {
    setSavingProvider(provider);
    try {
      await apiClient.delete(`/model-keys/${provider}`);
      message.success(`${PROVIDER_LABEL[provider] ?? provider} 的 API Key 已清除`);
      await refresh();
    } catch (e) {
      console.error('[ModelSettingsPage] clear key failed:', e);
      message.error('清除失败，请重试');
    } finally {
      setSavingProvider(null);
    }
  };

  const handleSelectModel = async (presetKey: ModelPresetName) => {
    const preset = MODEL_PRESETS[presetKey];
    if (!maskedByProvider[preset.provider]) {
      message.warning(`请先为 ${PROVIDER_LABEL[preset.provider] ?? preset.provider} 配置 API Key`);
      return;
    }
    try {
      await apiClient.patch('/model-keys', { selectedModel: presetKey });
      setLocalModel(presetKey);
      message.success(`已切换当前模型为 ${preset.label}`);
      await refresh();
    } catch (e) {
      console.error('[ModelSettingsPage] select model failed:', e);
      message.error('切换模型失败，请重试');
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
        <h2 className="mb-1 text-[18px] font-semibold text-[#111827]">模型管理</h2>
        <p className="text-[13px] text-[#9ca3af]">
          选择模型并填写对应厂商的 API Key。密钥经加密存储且不会回显，仅向你展示掩码状态。
        </p>
      </div>

      {/* 当前使用模型 */}
      <section>
        <h3 className="mb-3 text-[15px] font-medium text-[#111827]">当前使用模型</h3>
        {selectedModel && MODEL_PRESETS[selectedModel as ModelPresetName] ? (
          <div className="flex items-center gap-2 text-[14px]">
            <CheckCircleFilled className="text-[#16a34a]" />
            <span className="font-medium text-[#374151]">
              {MODEL_PRESETS[selectedModel as ModelPresetName].label}
            </span>
          </div>
        ) : (
          <p className="text-[13px] text-[#9ca3af]">尚未选择，请在下方为模型配置 Key 并点击「设为当前」。</p>
        )}
      </section>

      {/* 按 provider 分组的预设 + Key 配置 */}
      {grouped.map(({ provider, items }) => {
        const masked = maskedByProvider[provider];
        const busy = savingProvider === provider;
        return (
          <section key={provider} className="rounded-xl border border-[#e5e7eb] p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-medium text-[#111827]">
                  {PROVIDER_LABEL[provider] ?? provider}
                </span>
                {masked ? (
                  <Tag color="green" style={{ margin: 0 }}>
                    已配置 {masked}
                  </Tag>
                ) : (
                  <Tag style={{ margin: 0 }}>未配置</Tag>
                )}
              </div>
            </div>

            {/* 该 provider 下的预设模型 */}
            <div className="mb-4 flex flex-col gap-2">
              {items.map((preset) => {
                const isCurrent = selectedModel === preset.key;
                return (
                  <div
                    key={preset.key}
                    className="flex items-center justify-between rounded-lg border border-[#f0f0f0] px-3 py-2"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[14px] font-medium text-[#111827]">
                          {preset.label}
                        </span>
                        {preset.isBeta && (
                          <span className="rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-800">
                            Beta
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[12px] text-[#9ca3af]">{preset.description}</p>
                    </div>
                    {isCurrent ? (
                      <span className="flex items-center gap-1 text-[12px] font-medium text-[#0f766e]">
                        <CheckCircleFilled />
                        当前
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={!masked}
                        onClick={() => handleSelectModel(preset.key)}
                        className="h-8 cursor-pointer rounded-lg border border-[#0f766e] px-3 text-[13px] font-medium text-[#0f766e] transition-all hover:bg-[#d7f2f0] disabled:cursor-not-allowed disabled:border-[#e5e7eb] disabled:text-[#9ca3af] disabled:hover:bg-transparent"
                      >
                        设为当前
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Key 输入 / 保存 / 清除 */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <KeyOutlined className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9ca3af]" />
                <input
                  type="password"
                  value={drafts[provider] ?? ''}
                  onChange={(e) =>
                    setDrafts((prev) => ({ ...prev, [provider]: e.target.value }))
                  }
                  placeholder={masked ? '粘贴新 API Key 以覆盖' : '粘贴 API Key'}
                  className={`${inputClass} pl-9`}
                />
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleSaveKey(provider)}
                className="h-10 cursor-pointer rounded-lg bg-[#0f766e] px-4 text-[14px] font-medium text-white transition-all hover:bg-[#0d655e] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? '处理中…' : '保存'}
              </button>
              {masked && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleClearKey(provider)}
                  className="h-10 cursor-pointer rounded-lg border border-[#dc2626] px-4 text-[14px] font-medium text-[#dc2626] transition-all hover:bg-[#fef2f2] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  清除
                </button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
