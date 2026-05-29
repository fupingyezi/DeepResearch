import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ModelPresetName, MODEL_PRESETS } from '@/config/models';

interface ModelState {
  model: ModelPresetName;
  setModel: (model: ModelPresetName) => void;
}

const DEFAULT_MODEL: ModelPresetName = 'deepseek-v4-flash';

/**
 * useModelStore
 * 管理用户选择的模型预设
 * 使用 localStorage 持久化用户偏好
 */
export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      model: DEFAULT_MODEL,
      setModel: (model: ModelPresetName) => {
        // 验证模型有效性
        if (MODEL_PRESETS[model]) {
          set({ model });
        } else {
          console.warn(`[useModelStore] Unknown model: ${model}`);
        }
      },
    }),
    {
      name: 'model-store',
      // version 历史：
      // - v1：默认 qwen-max
      // - v2：默认改为 deepseek-v4-flash（迁移老用户）
      // - v3：字段从 selectedModelKey 重命名为 model
      version: 3,
      migrate: (persistedState: unknown, version: number) => {
        const raw = (persistedState ?? {}) as Record<string, unknown>;

        // v2 → v3：把 selectedModelKey 搬到 model
        if (version < 3 && 'selectedModelKey' in raw) {
          raw.model = raw.selectedModelKey;
          delete raw.selectedModelKey;
        }

        const state = raw as Partial<ModelState>;

        // v1 默认是 qwen-max；老用户如果从未主动切换，迁移到新默认值
        if (version < 2 && state.model === ('qwen-max' as ModelPresetName)) {
          return { ...state, model: DEFAULT_MODEL } as ModelState;
        }

        // 持久化里出现了未知模型，回退到默认
        if (state.model && !MODEL_PRESETS[state.model]) {
          return { ...state, model: DEFAULT_MODEL } as ModelState;
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
  const model = useModelStore((s) => s.model);
  return MODEL_PRESETS[model] || MODEL_PRESETS[DEFAULT_MODEL];
}
