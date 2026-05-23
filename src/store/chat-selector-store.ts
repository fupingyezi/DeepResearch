import { create } from "zustand";

export type agentMode = "chat" | "search" | "deepResearch";

export interface ChatSelectState {
  selectedAgent: agentMode;
  setSelectedAgent: (selectedAgent: agentMode) => void;
}

const useChatSelectStore = create<ChatSelectState>((set) => ({
  selectedAgent: "chat",
  setSelectedAgent: (selectedAgent: agentMode) =>
    set(() => ({
      selectedAgent: selectedAgent,
    })),
}));

export default useChatSelectStore;
