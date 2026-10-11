/**
 * user_model_keys 表 + users.selected_model 的领域类型与访问契约。
 *
 * 安全模型：Key 密文落库（ciphertext + iv + authTag + 掩码），明文只在
 * getDecryptedKey 内部短暂出现；全部方法以 userId 为第一筛选条件（按本人隔离）。
 */

/** 已配置 provider 的对外安全视图（不含明文 / 密文）。 */
export interface ConfiguredProvider {
  provider: string;
  masked: string;
}

export interface UserModelKeyRepository {
  /** 保存（upsert）某 provider 的 API Key，返回掩码视图 */
  upsertModelKey(
    userId: string,
    provider: string,
    apiKeyPlain: string,
  ): Promise<ConfiguredProvider>;
  /** 删除本人某 provider 的 Key */
  deleteModelKey(userId: string, provider: string): Promise<void>;
  /** 列出本人已配置的 provider + 掩码（绝不含明文） */
  listConfiguredProviders(userId: string): Promise<ConfiguredProvider[]>;
  /** 读取本人某 provider 的明文 Key（解密）；未配置 / 解密失败返回 null */
  getDecryptedKey(userId: string, provider: string): Promise<string | null>;
  /** 读取用户当前选用的模型预设 key；未设置返回 null */
  getSelectedModel(userId: string): Promise<string | null>;
  /** 设置用户当前选用的模型预设 key */
  setSelectedModel(userId: string, modelKey: string): Promise<void>;
}
