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
        if (MODEL_PRESETS[model]) {
          set({ model });
        } else {
          console.warn(`[useModelStore] Unknown model: ${model}`);
        }
      },
    }),
    {
      name: 'model-store',
    },
  ),
);

/**
 * 获取当前选中的模型预设
 */
export function getCurrentModelPreset() {
  // 非 React 上下文不能调用 zustand hook（rules-of-hooks），用 getState() 直接读
  const model = useModelStore.getState().model;
  return MODEL_PRESETS[model] || MODEL_PRESETS[DEFAULT_MODEL];
}
