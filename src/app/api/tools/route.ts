import { NextResponse } from 'next/server';

import { askClarificationTool, searchWebTool, taskTool } from '@/deerflow-harness/tools';
import { withApiHandler } from '@/server/http';

type ToolCategory = 'builtin' | 'agent';

interface ToolInfo {
  name: string;
  displayName: string;
  description: string;
  category: ToolCategory;
  enabled: boolean;
}

/**
 * 工具展示元信息：从真实注册的工具实例读取 name/description，
 * 补充中文展示名与分类。内置工具默认启用，暂不支持 per-user 开关。
 */
const TOOL_META: Array<{
  tool: { name?: string; description?: string };
  displayName: string;
  category: ToolCategory;
}> = [
  { tool: searchWebTool, displayName: '联网搜索', category: 'builtin' },
  { tool: taskTool, displayName: '任务委派', category: 'agent' },
  { tool: askClarificationTool, displayName: '澄清提问', category: 'agent' },
];

export const GET = withApiHandler({}, async () => {
  const data: ToolInfo[] = TOOL_META.map(({ tool, displayName, category }) => ({
    name: tool.name ?? 'unknown',
    displayName,
    description: tool.description ?? '',
    category,
    enabled: true,
  }));

  return NextResponse.json({ message: 'Get tools success!', data }, { status: 200 });
});
