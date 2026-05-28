import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ModelPresetKey, MODEL_PRESETS } from '@/config/models';

interface ModelState {
  selectedModelKey: ModelPresetKey;
  setSelectedModelKey: (key: ModelPresetKey) => void;
}

const DEFAULT_MODEL_KEY: ModelPresetKey = 'deepseek-v4-flash';

/**
 * useModelStore
 * 管理用户选择的模型预设
 * 使用 localStorage 持久化用户偏好
 */
export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      selectedModelKey: DEFAULT_MODEL_KEY,
      setSelectedModelKey: (key: ModelPresetKey) => {
        // 验证模型 key 的有效性
        if (MODEL_PRESETS[key]) {
          set({ selectedModelKey: key });
        } else {
          console.warn(`[useModelStore] Unknown model key: ${key}`);
        }
      },
    }),
    {
      name: 'model-store',
      // version 升至 2：把旧默认值（qwen-max）迁移到新默认值（deepseek-v4-flash）
      version: 2,
      migrate: (persistedState: unknown, version: number) => {
        const state = (persistedState ?? {}) as Partial<ModelState>;
        // v1 默认是 qwen-max；老用户如果从未主动切换，迁移到 deepseek-v4-flash
        if (version < 2 && state.selectedModelKey === 'qwen-max') {
          return { ...state, selectedModelKey: DEFAULT_MODEL_KEY } as ModelState;
        }
        // 持久化里出现了未知 key，也回退到默认
        if (state.selectedModelKey && !MODEL_PRESETS[state.selectedModelKey]) {
          return { ...state, selectedModelKey: DEFAULT_MODEL_KEY } as ModelState;
        }
        return state as ModelState;
      },
    },
  ),
);

/**
 * 获取当前选中的模型预设
 */
export function getCurrentModelPreset() {
  const key = useModelStore((s) => s.selectedModelKey);
  return MODEL_PRESETS[key] || MODEL_PRESETS[DEFAULT_MODEL_KEY];
}
