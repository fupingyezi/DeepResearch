import { SubagentConfig } from '../config';
import { registerSubagent } from '../registry';

/**
 * general-purpose subagent —— 对齐 deer-flow 2.0 `general_purpose.py`
 *
 * 角色：通用任务执行子 agent。lead-agent 通过 `task("general-purpose", ...)`
 * 把"可分解的复杂子任务"委派给它执行。
 *
 * 关键属性：
 * - `tools: undefined` —— 继承 lead 的全部工具集（在 task-tool 中按 lead 工具集装载，
 *   并按 `disabledTools` 过滤）。
 * - `disabledTools: ['task']` —— 禁止子 agent 再次调用 `task`，杜绝
 *   lead → subagent → subagent 套娃。
 * - `model: 'inherit'` —— 复用 lead 当前 ModelConfig（通过 runtime context 透传），
 *   保证 subagent 与 lead 走同一模型/配置/baseUrl/apiKey。
 */
export const generalPurposeConfig: SubagentConfig = {
  name: 'general-purpose',
  description:
    'A capable agent for complex, multi-step tasks that require both exploration and action. ' +
    'Use this subagent when: (1) the task requires both exploration and modification, ' +
    '(2) complex reasoning is needed to interpret results, ' +
    '(3) multiple dependent steps must be executed, ' +
    '(4) the task would benefit from isolated context management. ' +
    'Do NOT use for simple, single-step operations.',
  systemPrompt: [
    'You are a general-purpose subagent working on a delegated task.',
    'Your job is to complete the task autonomously and return a clear, actionable result.',
    '',
    '<guidelines>',
    '- Focus on completing the delegated task efficiently',
    '- Use available tools as needed to accomplish the goal',
    '- Think step by step but act decisively',
    '- If you encounter issues, explain them clearly in your response',
    '- Return a concise summary of what you accomplished',
    '- Do NOT ask for clarification - work with the information provided',
    '- Do NOT call the `task` tool to spawn further subagents (forbidden by config)',
    '</guidelines>',
    '',
    '<output_format>',
    'When you complete the task, provide:',
    '1. A brief summary of what was accomplished',
    '2. Key findings or results',
    '3. Any relevant data, file paths, or links surfaced',
    '4. Issues encountered (if any)',
    '5. Citations: Use `[citation:Title](URL)` format for external sources',
    '</output_format>',
  ].join('\n'),
  // 'inherit' 在 SubagentExecutor 中被识别为"复用 lead 当前 ModelConfig"。
  model: 'inherit',
  maxTurns: 100,
  timeout: 600,
  // tools=undefined 表示"继承 lead 工具集"；具体装载逻辑在 task-tool 中按
  // disabledTools 黑名单过滤后传入 SubagentExecutor。
  tools: undefined,
  disabledTools: ['task'],
};

registerSubagent(generalPurposeConfig);
