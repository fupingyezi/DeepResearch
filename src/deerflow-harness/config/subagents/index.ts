/**
 * Sub-agent 配置自动加载
 *
 * 导入所有 Sub-agent 配置文件并注册到 SubAgentRegistry。
 * 新增 Sub-agent 只需在此目录下创建 .config.ts 文件并在此处导入。
 */

import { SubAgentRegistry } from "../../agents/SubAgentRegistry";
import { simpleAnalyserConfig } from "./simpleAnalyser.config";
import { taskDecomposerConfig } from "./taskDecomposer.config";
import { taskHandlerConfig } from "./taskHandler.config";
import { reportGeneratorConfig } from "./reportGenerator.config";

/**
 * 所有 Sub-agent 配置列表
 *
 * 新增 Sub-agent 时，只需：
 * 1. 在此目录下创建 xxx.config.ts 文件
 * 2. 在此处导入并添加到数组中
 */
const allSubAgentConfigs = [
  simpleAnalyserConfig,
  taskDecomposerConfig,
  taskHandlerConfig,
  reportGeneratorConfig,
];

/**
 * 加载并注册所有 Sub-agent 配置
 *
 * 在系统启动时调用此函数，自动扫描并注册所有 Sub-agent。
 */
export function loadAllSubAgents(): void {
  const registry = SubAgentRegistry.getInstance();

  for (const config of allSubAgentConfigs) {
    registry.register(config);
  }

  console.log(
    `[SubAgents] Loaded ${allSubAgentConfigs.length} sub-agent configurations: ${allSubAgentConfigs.map((c) => c.name).join(", ")}`,
  );
}

/**
 * 导出所有配置（供外部直接引用）
 */
export {
  simpleAnalyserConfig,
  taskDecomposerConfig,
  taskHandlerConfig,
  reportGeneratorConfig,
};
