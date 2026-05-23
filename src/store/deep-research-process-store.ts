import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { taskType } from "@/types";

export type processStatusType =
  | "notCall"
  | "initial"
  | "processing"
  | "end"
  | "interrupt";

export type INTR = {
  question: string;
  details: any;
};

export interface DeepResearchProcessState {
  currentDeepResearchId: string;
  isOpenProcessSider: boolean;
  status: processStatusType;
  researchTarget: string;
  simpleAnalysis: string;
  tasks: taskType[];
  report: string;
  interruptRequest: { question: string; details: any } | null;
  resetState: () => void;
  setCurrentDeepResearchId: (id: string) => void;
  setIsOpenProcessSider: (isOpenProcessSider: boolean) => void;
  setStatus: (status: processStatusType) => void;
  setSimpleAnalysis: (simpleAnalysis: string) => void;
  setResearchTargt: (researchTarget: string) => void;
  initialTasks: (tasks: taskType[]) => void;
  setTasks: (tasks: taskType[]) => void;
  /** 单条更新（按 taskId 匹配；命中则覆盖该项，未命中则忽略） */
  updateTasks: (task: taskType) => void;
  /** 动态追加（按 taskId 去重；已存在则就地更新） */
  addTask: (task: taskType) => void;
  updateReport: (report: string) => void;
  setInterruptRequest: (request: INTR) => void;
}

const useDeepResearchProcessStore = create<DeepResearchProcessState>()(
  immer((set) => ({
    currentDeepResearchId: "",
    isOpenProcessSider: false,
    status: "notCall",
    researchTarget: "",
    simpleAnalysis: "",
    tasks: [],
    report: "",
    interruptRequest: null,
    resetState: () =>
      set(() => ({
        isOpenProcessSider: false,
        status: "notCall",
        researchTarget: "",
        simpleAnalysis: "",
        tasks: [],
        report: "",
      })),
    setCurrentDeepResearchId: (id) =>
      set((state) => {
        state.currentDeepResearchId = id;
      }),
    setIsOpenProcessSider: (isOpenProcessSider: boolean) =>
      set((state) => {
        // 高频帧（task_update）幂等：值未变则不 mutate，避免触发不必要的订阅刷新
        if (state.isOpenProcessSider === isOpenProcessSider) return;
        state.isOpenProcessSider = isOpenProcessSider;
      }),
    setStatus: (status: processStatusType) =>
      set((state) =>
        // 值未变则不返回新对象，避免每帧 stream 都让所有订阅者重渲染
        state.status === status ? {} : { status }
      ),
    setResearchTargt: (researchTarget: string) =>
      set((state) => {
        if (state.researchTarget === researchTarget) return;
        state.researchTarget = researchTarget;
      }),
    setSimpleAnalysis: (simpleAnalysis: string) =>
      set((state) => {
        if (state.simpleAnalysis === simpleAnalysis) return;
        state.simpleAnalysis = simpleAnalysis;
      }),
    initialTasks: (tasks: taskType[]) =>
      set((state) => {
        state.tasks = tasks;
      }),
    setTasks: (tasks: taskType[]) =>
      set((state) => {
        state.tasks = tasks;
      }),
    updateTasks: (task: taskType) =>
      set((state) => {
        const index = state.tasks.findIndex((t) => t.taskId === task.taskId);
        if (index !== -1) {
          state.tasks[index] = task;
        }
      }),
    addTask: (task: taskType) =>
      set((state) => {
        const index = state.tasks.findIndex((t) => t.taskId === task.taskId);
        if (index !== -1) {
          // upsert：仅用 task 中**显式提供**（!= undefined）的字段覆盖原值。
          // 背景：后端 task_progress 折叠后，不同 status 帧只携带各自相关字段
          // （running 帧没 description，started 帧没 result 等）。如果直接 spread
          // `{ ...prev, ...task }`，未提供的字段会被 undefined 覆盖，造成右栏
          // "任务划分"标题在 running 帧瞬间消失再复现的闪烁。
          const prev = state.tasks[index];
          const merged = { ...prev };
          (Object.keys(task) as (keyof taskType)[]).forEach((k) => {
            const v = task[k];
            if (v !== undefined) {
              (merged as any)[k] = v;
            }
          });
          state.tasks[index] = merged;
        } else {
          state.tasks.push(task);
        }
      }),
    updateReport: (report: string) =>
      set((state) => {
        state.report = report;
      }),
    setInterruptRequest: (request: INTR) =>
      set((state) => {
        state.interruptRequest = request;
      }),
  }))
);

export default useDeepResearchProcessStore;
