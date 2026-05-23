export interface SubagentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  maxTurns: number;
  timeout: number;
  tools?: string[];
  disabledTools?: string[];
  skills?: string[];
}
