export interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
  status: "pending" | "streaming" | "complete";
  startTime: number;
}

export class ToolCallTracker {
  private activeCalls: Map<string, ToolCallState> = new Map();
  private maxActiveCalls = 100;

  startCall(id: string, name: string): void {
    if (this.activeCalls.size >= this.maxActiveCalls) {
      const oldestId = this.activeCalls.keys().next().value;
      if (oldestId) {
        this.activeCalls.delete(oldestId);
      }
    }

    this.activeCalls.set(id, {
      id,
      name,
      arguments: "",
      status: "pending",
      startTime: Date.now(),
    });
  }

  updateCall(id: string, delta: string): void {
    const call = this.activeCalls.get(id);
    if (call) {
      call.arguments += delta;
      call.status = "streaming";
      this.activeCalls.set(id, call);
    }
  }

  completeCall(id: string): ToolCallState | undefined {
    const call = this.activeCalls.get(id);
    if (call) {
      call.status = "complete";
      this.activeCalls.set(id, call);
      return call;
    }
    return undefined;
  }

  getCall(id: string): ToolCallState | undefined {
    return this.activeCalls.get(id);
  }

  isActive(id: string): boolean {
    const call = this.activeCalls.get(id);
    return call !== undefined && call.status !== "complete";
  }

  getActiveCalls(): Map<string, ToolCallState> {
    return this.activeCalls;
  }

  clear(): void {
    this.activeCalls.clear();
  }
}
