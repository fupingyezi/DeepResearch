/**
 * 用户级模型 API Key 管理服务。
 *
 * 安全不变量：明文 Key 永不回显——upsert 返回掩码（masked），列表接口只含掩码；
 * 全部读写按本人 user_id 隔离（auth 侧 repository 已保证）。
 *
 * VALID_PROVIDERS 是 provider 白名单的单一出处：从 MODEL_PRESETS 派生，
 * 避免写入/删除非法 provider；两个路由共用。
 */

import {
  deleteModelKey,
  getSelectedModel,
  listConfiguredProviders,
  setSelectedModel,
  upsertModelKey,
  type ConfiguredProvider,
} from '@deerflow-harness/auth';
import { MODEL_PRESETS, type ModelPresetName } from '@/config/models';
import { AppError } from '@/server/http';

export const VALID_PROVIDERS = new Set<string>(
  Object.values(MODEL_PRESETS).map((preset) => preset.provider),
);

export interface ModelKeyServiceDeps {
  listConfigured: typeof listConfiguredProviders;
  getSelected: typeof getSelectedModel;
  upsert: typeof upsertModelKey;
  setSelected: typeof setSelectedModel;
  deleteKey: typeof deleteModelKey;
}

export class ModelKeyService {
  constructor(private readonly deps: ModelKeyServiceDeps) {}

  /** 已配置 provider + 掩码 + 当前选用模型。 */
  async list(userId: string): Promise<{
    configured: ConfiguredProvider[];
    selectedModel: string | null;
  }> {
    const [configured, selectedModel] = await Promise.all([
      this.deps.listConfigured(userId),
      this.deps.getSelected(userId),
    ]);
    return { configured, selectedModel };
  }

  /** 保存 / 覆盖某 provider 的 API Key（加密落库），返回掩码信息。 */
  async saveKey(userId: string, provider: string, apiKey: string): Promise<ConfiguredProvider> {
    if (!VALID_PROVIDERS.has(provider)) {
      throw new AppError('Invalid or unsupported provider', 'PROVIDER_NOT_SUPPORTED', 400);
    }
    return this.deps.upsert(userId, provider, apiKey);
  }

  /**
   * 设置当前选用模型预设。预检：预设必须存在，且其 provider 必须已配置 Key
   * —— 否则会选中一个无法使用的模型，之后每次对话都在预检阶段 400。
   */
  async selectModel(userId: string, selectedModel: string): Promise<void> {
    const preset = MODEL_PRESETS[selectedModel as ModelPresetName];
    if (!preset) {
      throw new AppError('Invalid model preset', 'INVALID_INPUT', 400);
    }

    const configured = await this.deps.listConfigured(userId);
    const hasKey = configured.some((c) => c.provider === preset.provider);
    if (!hasKey) {
      throw new AppError(
        `Provider "${preset.provider}" has no API key configured`,
        'PROVIDER_HAS_NO_KEY',
        400,
      );
    }

    await this.deps.setSelected(userId, selectedModel);
  }

  /** 删除本人某 provider 的 Key。 */
  async deleteKey(userId: string, rawProvider: string): Promise<void> {
    const provider = rawProvider.trim();
    if (!provider || !VALID_PROVIDERS.has(provider)) {
      throw new AppError('Invalid or unsupported provider', 'PROVIDER_NOT_SUPPORTED', 400);
    }
    await this.deps.deleteKey(userId, provider);
  }
}

const defaultDeps: ModelKeyServiceDeps = {
  listConfigured: listConfiguredProviders,
  getSelected: getSelectedModel,
  upsert: upsertModelKey,
  setSelected: setSelectedModel,
  deleteKey: deleteModelKey,
};

/**
 * 工厂 + 模块级懒单例。无跨请求可变状态（数据在 PG、密钥加密逻辑在 auth
 * repository），模块级单例即可，无需 globalThis。
 */
export function createModelKeyService(deps: ModelKeyServiceDeps = defaultDeps): ModelKeyService {
  return new ModelKeyService(deps);
}

let _modelKeyService: ModelKeyService | null = null;
export function getModelKeyService(): ModelKeyService {
  if (!_modelKeyService) _modelKeyService = createModelKeyService();
  return _modelKeyService;
}
