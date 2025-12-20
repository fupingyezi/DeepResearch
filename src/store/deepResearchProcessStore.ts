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
  updateTasks: (task: taskType) => void;
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
        state.isOpenProcessSider = isOpenProcessSider;
      }),
    setStatus: (status: processStatusType) =>
      set(() => ({
        status: status,
      })),
    setResearchTargt: (researchTarget: string) =>
      set((state) => {
        state.researchTarget = researchTarget;
      }),
    setSimpleAnalysis: (simpleAnalysis: string) =>
      set((state) => {
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
