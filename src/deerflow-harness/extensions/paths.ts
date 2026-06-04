/**
 * extensions 子系统路径解析。
 *
 * 优先级：
 *   - 配置文件：process.env.DEERFLOW_EXTENSIONS_CONFIG_PATH > {cwd}/extensions_config.json
 *   - 技能目录：process.env.DEERFLOW_SKILLS_DIR > {cwd}/skills
 *
 * cwd 在 Next.js 运行期即仓库根目录，内置技能（skills/public/*）随仓库分发。
 */

import * as path from 'node:path';

export function getExtensionsConfigPath(): string {
  const env = process.env.DEERFLOW_EXTENSIONS_CONFIG_PATH;
  if (env && env.trim().length > 0) return env;
  return path.join(process.cwd(), 'extensions_config.json');
}

export function getSkillsRootDir(): string {
  const env = process.env.DEERFLOW_SKILLS_DIR;
  if (env && env.trim().length > 0) return env;
  return path.join(process.cwd(), 'skills');
}

export function getPublicSkillsDir(): string {
  return path.join(getSkillsRootDir(), 'public');
}

export function getCustomSkillsDir(): string {
  return path.join(getSkillsRootDir(), 'custom');
}
