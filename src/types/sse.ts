export type SSEEvent =
  | { type: "start"; timestamp: number }
  | { type: "content"; content: string; role: string; id?: string | number }
  | { type: "state"; payload: Record<string, any> } // 用于 deep-research
  | { type: "done"; done: true }
  | { type: "error"; content: string; done: true };
