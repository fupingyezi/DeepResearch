import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import apiClient from '@/utils/request/api';
import { isMemoryInjectionMode, type MemoryInjectionMode } from '@/types';

/** 记忆注入模式（类型与守卫定义在 @/types —— 那也是请求体契约的所在地）。 */
export type MemoryMode = MemoryInjectionMode;

export const DEFAULT_MEMORY_MODE: MemoryMode = 'inject';

const isMemoryMode = isMemoryInjectionMode;

interface MemoryModeState {
  mode: MemoryMode;
  /** 本次会话是否已与服务端同步过（不进持久化，保证每次加载都以服务端为准）。 */
  synced: boolean;
  /** 本地更新（设置页成功写入服务端后调用；也用于即时反馈）。 */
  setMode: (mode: MemoryMode) => void;
  /** 从服务端拉取一次（幂等，并发合并）。 */
  load: () => Promise<void>;
}

let inflight: Promise<void> | null = null;

/**
 * useMemoryModeStore
 *
 * 记忆注入模式的客户端视图。**服务端（users.memory_mode）是唯一真相源**，
 * 这里只做两件事：① 发送对话时能同步读到当前值；② 首屏渲染时先用上次缓存，
 * 避免请求返回前误用默认值。`synced` 刻意不持久化 —— 否则换设备后本地会
 * 一直认为已同步，服务端的新值永远拉不回来。
 */
export const useMemoryModeStore = create<MemoryModeState>()(
  persist(
    (set, get) => ({
      mode: DEFAULT_MEMORY_MODE,
      synced: false,

      setMode: (mode: MemoryMode) => {
        if (!isMemoryMode(mode)) {
          console.warn(`[memoryModeStore] Unknown mode: ${String(mode)}`);
          return;
        }
        set({ mode, synced: true });
      },

      load: async () => {
        if (get().synced) return;
        if (inflight) return inflight;
        inflight = (async () => {
          try {
            const res = await apiClient.get('/memory/mode');
            const mode = (res?.data as { data?: { mode?: unknown } } | undefined)?.data?.mode;
            if (isMemoryMode(mode)) set({ mode, synced: true });
          } catch (e) {
            // 拉取失败保持本地缓存值（不阻塞对话），下次挂载重试
            console.error('[memoryModeStore] load failed:', e);
          } finally {
            inflight = null;
          }
        })();
        return inflight;
      },
    }),
    {
      name: 'memory-mode-store',
      // 只缓存 mode；synced 必须每次从 false 开始
      partialize: (state) => ({ mode: state.mode }),
    },
  ),
);
