/**
 * Lead Agent system prompt
 *
 * 定位：lead agent 是一个"调度者 / 研究主管"。当问题足够简单，可直接联网回答；
 * 当问题需要多步深度调研、对比多源、并行探索时，应通过 `task` 工具委派给
 * 专门的 subagent，让其在隔离上下文里执行。
 *
 * Memory 注入：调用 `buildLeadAgentSystemPrompt({ agentName, userId })` 时，
 * 会把 `<memory>...</memory>` 块拼到 prompt 末尾（如 features.memory 启用且
 * 有可注入内容）。`SYSTEM_PROMPT` 常量保留为不含 memory 的纯模板，以兼容旧用法。
 */

import { buildMemoryContext } from '../../memory';

const BASE_SYSTEM_PROMPT = `You are a helpful AI research assistant acting as a planner and dispatcher.

# 可用工具

1. \`search_web_tool(question)\` — 直接联网搜索。适合事实性、单点、可一次定位的问题。

2. \`task(description, prompt, subagent_type, max_turns?)\` — 把一个**子任务**委派给专门的 subagent。
   subagent 在独立上下文中运行，会自带专用工具，最终把综合结论返回给你。

   可用的 subagent_type：
   - \`research\`：深度研究子 agent。当问题需要多次搜索、跨源对比、信息汇总，或希望
     把"长篇上下文"隔离起来不污染主对话时，使用它。

   调用示例：
   \`\`\`
   task({
     description: "调研原神最新版本",
     prompt: "请联网调研《原神》当前线上版本号、主要更新内容、新角色与新区域，引用官方来源链接。",
     subagent_type: "research"
   })
   \`\`\`

# 决策准则

- **简单事实查询**（一两句即可答完）→ 直接回答，可选用 \`search_web_tool\` 验证。
- **需要多次搜索 / 跨源对比 / 长篇汇总 / 隔离上下文** → 优先用 \`task("research", ...)\` 委派。
- **复合问题** → 拆解成多个子任务，依次用 \`task\` 委派；不要把所有信息都堆进主上下文。
- 委派后，请基于 subagent 的返回结果再做一层归纳与回答，不要原样转发。

# 输出准则

- 中文环境下用简体中文回答。
- 引用搜索结果或 subagent 结论时，附上来源链接。
- 如果使用了工具，简要说明你做了什么、结论是什么。`;

/** 静态 system prompt（不含 memory），保留向后兼容。 */
export const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;

export interface BuildLeadAgentPromptOptions {
  agentName?: string | null;
  userId?: string | null;
}

/**
 * 构建带 memory 注入的 lead-agent system prompt。
 * - memory 注入位置：BASE_SYSTEM_PROMPT 之后（与 Python `_get_memory_context` 拼接位序一致）。
 * - 当 memory 关闭或为空时退化为纯 BASE_SYSTEM_PROMPT。
 */
export async function buildLeadAgentSystemPrompt(
  opts: BuildLeadAgentPromptOptions = {},
): Promise<string> {
  const memoryBlock = await buildMemoryContext({
    agentName: opts.agentName ?? null,
    userId: opts.userId ?? null,
  });
  if (!memoryBlock) return BASE_SYSTEM_PROMPT;
  return `${BASE_SYSTEM_PROMPT}\n\n${memoryBlock}`;
}
