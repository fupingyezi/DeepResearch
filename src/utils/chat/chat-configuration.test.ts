import { describe, expect, it } from 'vitest';

import { buildChatConfiguration } from './chat-configuration';

/**
 * 回归守卫：用户可见开关的落点。参数被静默丢弃时功能会悄无声息地失效
 * （本仓历史上发生过多次同类问题），故把请求体契约钉在这里。
 */
describe('buildChatConfiguration', () => {
  it('memoryMode=retrieve 时带上该字段（开关真正生效的最小前提）', () => {
    expect(buildChatConfiguration({ memoryMode: 'retrieve' })).toEqual({
      memoryMode: 'retrieve',
    });
  });

  it('memoryMode=inject 时同样带上（显式全量注入，而非依赖默认）', () => {
    expect(buildChatConfiguration({ memoryMode: 'inject' })).toEqual({ memoryMode: 'inject' });
  });

  it('未选模式 / 非法值时不带该键（由后端按服务级默认处理）', () => {
    expect(buildChatConfiguration({})).toEqual({});
    expect(buildChatConfiguration({ memoryMode: undefined })).toEqual({});
    // 拼写错误不得静默变成某个模式
    expect(buildChatConfiguration({ memoryMode: 'retrive' as never })).toEqual({});
  });

  it('model 与 memoryMode 同时存在时互不覆盖', () => {
    expect(buildChatConfiguration({ model: 'qwen-max', memoryMode: 'retrieve' })).toEqual({
      model: { value: 'qwen-max' },
      memoryMode: 'retrieve',
    });
  });

  it('空 model 字符串不产出 configuration（避免下发空模型名）', () => {
    expect(buildChatConfiguration({ model: '' })).toEqual({});
  });
});
