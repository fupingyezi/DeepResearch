// 导出新的Agent系统
export { BaseAgentServer } from "./BaseAgentServer";
export type { AgentConfig, AgentResponse } from "./BaseAgentServer";

export { ChatAgentServer } from "./ChatAgentServer";
export { SearchAgentServer } from "./SearchAgentServer";
export { DeepResearchAgentServer } from "./DeepResearchAgentServer";

export { AgentManager, AgentType } from "./AgentManager";

// 保持向后兼容的导出
import { chatAgent, chatAgentStream } from "./basicAgent/basicAgents";
import { createDeepResearchWorkflow } from "./deepResearchWrokFlow/deepResearchAgent";

export { chatAgent, chatAgentStream };
export { createDeepResearchWorkflow };
