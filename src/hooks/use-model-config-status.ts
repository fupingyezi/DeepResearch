'use client';

import { useCallback, useEffect, useState } from 'react';

import apiClient from '@/utils/request/api';
import { MODEL_PRESETS, type ModelPresetName } from '@/config/models';

/** 单个已配置 provider 的对外视图（仅掩码，不含明文）。 */
export interface ConfiguredProviderStatus {
  provider: string;
  masked: string;
}

export interface ModelConfigStatus {
  /** 是否已配置至少一个可用 Key（决定聊天是否可发送）。 */
  hasUsableKey: boolean;
  /** 已配置 provider + 掩码列表。 */
  configured: ConfiguredProviderStatus[];
  /** 用户当前选用的模型预设 key（落库，跨设备一致）。 */
  selectedModel: string | null;
  /** 是否加载中（首次拉取）。 */
  loading: boolean;
  /** 重新拉取最新状态（保存/删除/切换后调用），同时广播给其他实例。 */
  refresh: () => Promise<void>;
}

interface ModelKeysResponse {
  data?: {
    configured?: ConfiguredProviderStatus[];
    selectedModel?: string | null;
  };
}

/**
 * 跨组件状态同步：模块级单例缓存 + 订阅者列表。
 *
 * 背景：设置页与聊天输入框各自挂载了 useModelConfigStatus，若各自维护 state，
 * 设置页保存 Key 后只刷新自己，聊天输入框需手动刷新页面才能解禁。
 * 这里用模块级 store + 订阅广播，让任一实例 refresh 后所有实例同步更新。
 */
interface Snapshot {
  configured: ConfiguredProviderStatus[];
  selectedModel: string | null;
  loaded: boolean;
}

let snapshot: Snapshot = { configured: [], selectedModel: null, loaded: false };
const subscribers = new Set<(s: Snapshot) => void>();
let inflight: Promise<void> | null = null;

function broadcast() {
  for (const fn of subscribers) fn(snapshot);
}

async function fetchAndBroadcast(): Promise<void> {
  // 合并并发：多个实例同时挂载或保存后并发刷新，只发一次请求。
  if (inflight) return inflight;
  inflight = (async () => {
    const res = (await apiClient.get('/model-keys').catch((e) => {
      console.error('[useModelConfigStatus] fetch failed:', e);
      return null;
    })) as ModelKeysResponse | null;

    if (res?.data) {
      snapshot = {
        configured: res.data.configured ?? [],
        selectedModel: res.data.selectedModel ?? null,
        loaded: true,
      };
    } else {
      snapshot = { ...snapshot, loaded: true };
    }
    broadcast();
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * 拉取 /api/model-keys，返回用户的模型配置状态。
 *
 * 供「设置-模型管理」页与聊天输入框守卫共享：
 * - 输入框据 hasUsableKey 决定 submit 禁用与引导 placeholder。
 * - 设置页据 configured / selectedModel 渲染掩码状态与当前模型。
 *
 * 任一实例调用 refresh() 后，全部实例自动同步（无需刷新页面）。
 */
export function useModelConfigStatus(): ModelConfigStatus {
  const [state, setState] = useState<Snapshot>(snapshot);
  const [loading, setLoading] = useState(!snapshot.loaded);

  const refresh = useCallback(async () => {
    await fetchAndBroadcast();
  }, []);

  useEffect(() => {
    const onChange = (s: Snapshot) => setState(s);
    subscribers.add(onChange);

    // 首次挂载：若全局尚未加载过，拉一次；否则直接复用快照。
    if (!snapshot.loaded) {
      setLoading(true);
      fetchAndBroadcast().finally(() => setLoading(false));
    } else {
      setLoading(false);
    }

    return () => {
      subscribers.delete(onChange);
    };
  }, []);

  // 可发送的充要条件：已选当前模型，且该模型对应 provider 已配置 Key。
  // 仅"配置了某 Key 但未设为当前"不算 usable，避免发送时模型与 Key 不匹配而报错。
  const selectedPreset = state.selectedModel
    ? MODEL_PRESETS[state.selectedModel as ModelPresetName]
    : undefined;
  const hasUsableKey = Boolean(
    selectedPreset && state.configured.some((c) => c.provider === selectedPreset.provider),
  );

  return {
    hasUsableKey,
    configured: state.configured,
    selectedModel: state.selectedModel,
    loading,
    refresh,
  };
}

export default useModelConfigStatus;
