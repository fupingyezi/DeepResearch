/**
 * skills 域 HTTP 层逻辑（自 route.ts 抽出）：skill 列表读取 / 新建 / 启用切换。
 *
 * route.ts（/api/skills 与 /api/skills/[name]）是薄适配器，只保留 withApiHandler
 * 选项与 Next 配置导出（runtime），不再含业务 handler 体。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { ApiRouteHandler } from '@/backend/http';
import { getExtensionService } from '@/backend/services/extension-service';
import { createSkillSchema, patchEnabledSchema } from '@/backend/validation/schemas';

/** 列出全部 skill（public + custom，含 enabled 状态）。 */
export const list: ApiRouteHandler<undefined, undefined> = async () => {
  const skills = await getExtensionService().listSkills();
  return NextResponse.json({ message: 'Get skills success!', data: skills }, { status: 200 });
};

/** 新建自定义 skill（写入 skills/custom/<name>/SKILL.md）。 */
export const create: ApiRouteHandler<z.infer<typeof createSkillSchema>, undefined> = async ({
  body,
}) => {
  const skill = await getExtensionService().createSkill(body.name, body.content);
  return NextResponse.json({ message: 'Create skill success!', data: skill }, { status: 201 });
};

/** 切换某个 skill 的启用状态。 */
export const setEnabled: ApiRouteHandler<z.infer<typeof patchEnabledSchema>, undefined> = async ({
  body,
  params,
}) => {
  const skill = await getExtensionService().setSkillEnabled(params.name, body.enabled);
  return NextResponse.json({ message: 'Update skill success!', data: skill }, { status: 200 });
};

export const skillsController = { list, create, setEnabled };
