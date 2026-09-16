import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MEMORY_CONFIG,
  getMemoryConfig,
  loadMemoryConfigFromDict,
  setMemoryConfig,
} from './config';

afterEach(() => {
  setMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
});

describe('loadMemoryConfigFromDict', () => {
  it('缺省字典回落 DEFAULT（含新增的两个门槛字段）', () => {
    loadMemoryConfigFromDict({});
    const config = getMemoryConfig();
    expect(config.semanticMatchThreshold).toBe(0.6);
    expect(config.retrieveMinScore).toBe(0.05);
  });

  it('snake_case 与 camelCase 双键均可覆盖', () => {
    loadMemoryConfigFromDict({
      semantic_match_threshold: 0.5,
      retrieve_min_score: 0.1,
    });
    expect(getMemoryConfig().semanticMatchThreshold).toBe(0.5);
    expect(getMemoryConfig().retrieveMinScore).toBe(0.1);

    loadMemoryConfigFromDict({
      semanticMatchThreshold: 0.7,
      retrieveMinScore: 0.02,
    });
    expect(getMemoryConfig().semanticMatchThreshold).toBe(0.7);
    expect(getMemoryConfig().retrieveMinScore).toBe(0.02);
  });

  it('阈值 clamp 到 [0,1]，NaN 回落下界', () => {
    loadMemoryConfigFromDict({ semantic_match_threshold: 1.5, retrieve_min_score: -0.3 });
    expect(getMemoryConfig().semanticMatchThreshold).toBe(1);
    expect(getMemoryConfig().retrieveMinScore).toBe(0);

    loadMemoryConfigFromDict({ semantic_match_threshold: NaN });
    expect(getMemoryConfig().semanticMatchThreshold).toBe(0);
  });

  it('非数字类型被忽略（保持默认）', () => {
    loadMemoryConfigFromDict({ semantic_match_threshold: '0.5' as unknown as number });
    expect(getMemoryConfig().semanticMatchThreshold).toBe(0.6);
  });
});
