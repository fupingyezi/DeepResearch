import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MEMORY_CONFIG,
  getMemoryConfig,
  loadMemoryConfigFromDict,
  setMemoryConfig,
} from '../config';

afterEach(() => {
  setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
});

describe('loadMemoryConfigFromDict', () => {
  it('缺省字典回落 DEFAULT（语义门槛 + rerank 开关）', () => {
    loadMemoryConfigFromDict({});
    const config = getMemoryConfig();
    expect(config.semanticMatchThreshold).toBe(0.6);
    expect(config.rerankEnabled).toBe(true);
  });

  it('snake_case 与 camelCase 双键均可覆盖', () => {
    loadMemoryConfigFromDict({ semantic_match_threshold: 0.5, rerank_enabled: false });
    expect(getMemoryConfig().semanticMatchThreshold).toBe(0.5);
    expect(getMemoryConfig().rerankEnabled).toBe(false);

    loadMemoryConfigFromDict({ semanticMatchThreshold: 0.7, rerankEnabled: true });
    expect(getMemoryConfig().semanticMatchThreshold).toBe(0.7);
    expect(getMemoryConfig().rerankEnabled).toBe(true);
  });

  it('阈值 clamp 到 [0,1]，NaN 回落下界', () => {
    loadMemoryConfigFromDict({ semantic_match_threshold: 1.5 });
    expect(getMemoryConfig().semanticMatchThreshold).toBe(1);

    loadMemoryConfigFromDict({ semantic_match_threshold: -0.3 });
    expect(getMemoryConfig().semanticMatchThreshold).toBe(0);

    loadMemoryConfigFromDict({ semantic_match_threshold: NaN });
    expect(getMemoryConfig().semanticMatchThreshold).toBe(0);
  });

  it('非数字 / 非布尔类型被忽略（保持默认）', () => {
    loadMemoryConfigFromDict({
      semantic_match_threshold: '0.5' as unknown as number,
      rerank_enabled: 'false' as unknown as boolean,
    });
    expect(getMemoryConfig().semanticMatchThreshold).toBe(0.6);
    expect(getMemoryConfig().rerankEnabled).toBe(true);
  });
});
