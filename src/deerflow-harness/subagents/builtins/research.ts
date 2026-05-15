import { SubagentConfig } from '../config';
import { registerSubagent } from '../registry';

/**
 * Research subagent —— 内置示例
 *
 * 角色：网络信息收集 + 简要总结。仅装载 `search_web_tool`，强制不持有 task 工具，
 * 杜绝 lead → subagent → subagent 套娃。
 */
export const researchConfig: SubagentConfig = {
  name: 'research',
  description:
    '深度研究子 agent。当用户问题需要联网搜索、对比信息源或汇总外部资料时，' +
    '通过 task("research", ...) 委派给它执行。',
  systemPrompt: [
    '你是一个专注于信息检索与归纳的研究型子 agent。',
    '工作准则：',
    '1. 围绕主任务发起 1~3 次精准搜索，避免重复或宽泛 query。',
    '2. 在中文场景下保留原文关键词，必要时给出英文别名以提高召回。',
    '3. 用结构化 markdown 输出最终结论：要点列表 + 引用来源链接。',
    '4. 不要假设可以直接访问网页；只能依赖 search_web_tool 返回的片段。',
  ].join('\n'),
  // model 名称使用环境变量；createChatModel 内部会用 OPENAI_QWEN_* env 兜底。
  model: process.env.SUBAGENT_RESEARCH_MODEL ?? 'qwen3.6-plus',
  maxTurns: 10,
  timeout: 300,
  tools: ['search_web_tool'],
};

registerSubagent(researchConfig);
