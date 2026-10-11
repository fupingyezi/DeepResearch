import { afterEach, describe, expect, it } from 'vitest';

import {
  createDefaultMiddlewareConfigYaml,
  parseMiddlewareConfigYaml,
  resolveConfigEnvPlaceholders,
  middlewareConfigYamlSchema,
} from '../middleware-config';

const FULL_SAMPLE = `
config_version: 1

summarization:
  enabled: true
  trigger_tokens: 12000
  keep_messages: 8

loop_detection:
  enabled: true
  warn_threshold: 3
  hard_limit: 5
  window_size: 20
  tool_freq_warn: 30
  tool_freq_hard_limit: 50

guardrails:
  enabled: true
  block_mode: none

title:
  enabled: true

memory:
  enabled: true
  mode: inject
  model_name: null
  debounce_seconds: 30
  max_facts: 100
  fact_confidence_threshold: 0.7
  injection_enabled: true
  max_injection_tokens: 2000
  retrieve_top_k: 8
  retrieve_max_tokens: 800
  semantic_match_threshold: 0.6
  update_timeout_ms: 60000

sandbox:
  enabled: true

todo:
  enabled: true

thread_data:
  enabled: true

uploads:
  enabled: true

subagent_limit:
  enabled: true
  max_concurrent: 3
  max_total: 8
  max_tracked_threads: 100

extensions:
  middlewares: []
`;

describe('parseMiddlewareConfigYaml', () => {
  it('全块合法样例解析成功', () => {
    const config = parseMiddlewareConfigYaml(FULL_SAMPLE);
    expect(config.config_version).toBe(1);
    expect(config.summarization).toEqual({
      enabled: true,
      trigger_tokens: 12000,
      keep_messages: 8,
    });
    expect(config.loop_detection?.hard_limit).toBe(5);
    expect(config.guardrails?.block_mode).toBe('none');
    expect(config.memory?.mode).toBe('inject');
    expect(config.memory?.model_name).toBeNull();
    expect(config.subagent_limit?.max_total).toBe(8);
    expect(config.extensions?.middlewares).toEqual([]);
  });

  it('config_version 缺失时放行（默认 1）', () => {
    expect(parseMiddlewareConfigYaml('title:\n  enabled: true\n').config_version).toBeUndefined();
  });

  it('config_version 非 1 抛错（schema 演进闸门）', () => {
    expect(() => parseMiddlewareConfigYaml('config_version: 2\n')).toThrow(
      /unsupported config_version: 2/,
    );
  });

  it('config_version 类型错走 zod 抛错', () => {
    expect(() => parseMiddlewareConfigYaml('config_version: "1"\n')).toThrow();
  });

  it('未知顶层键抛错（zod strict）', () => {
    expect(() => parseMiddlewareConfigYaml('middlewares:\n  - a\n')).toThrow();
  });

  it('未知块内键抛错', () => {
    expect(() =>
      parseMiddlewareConfigYaml('summarization:\n  enabled: true\n  triggerToken: 1\n'),
    ).toThrow();
  });

  it('块内键类型错抛错', () => {
    expect(() =>
      parseMiddlewareConfigYaml('summarization:\n  enabled: true\n  trigger_tokens: "many"\n'),
    ).toThrow();
  });

  it('guardrails.block_mode 非法枚举抛错', () => {
    expect(() =>
      parseMiddlewareConfigYaml('guardrails:\n  enabled: true\n  block_mode: everything\n'),
    ).toThrow();
  });

  it('memory.mode 非法枚举抛错（拼写错误不能静默改变记忆行为）', () => {
    expect(() =>
      parseMiddlewareConfigYaml('memory:\n  enabled: true\n  mode: retrive\n'),
    ).toThrow();
  });

  it('YAML 语法错抛错', () => {
    expect(() => parseMiddlewareConfigYaml('summarization:\n  enabled: [unclosed\n')).toThrow();
  });

  it('空文件解析为空对象', () => {
    expect(parseMiddlewareConfigYaml('')).toEqual({});
  });
});

describe('resolveConfigEnvPlaceholders', () => {
  afterEach(() => {
    delete process.env.MWCFG_TEST_A;
    delete process.env.MWCFG_TEST_B;
  });

  it('$VAR 与 ${VAR} 两种形态替换', () => {
    process.env.MWCFG_TEST_A = 'hello';
    expect(resolveConfigEnvPlaceholders({ v: '$MWCFG_TEST_A ${MWCFG_TEST_A}' })).toEqual({
      v: 'hello hello',
    });
  });

  it('未解析占位符替换为空串（对齐 deer-flow，不留字面量）', () => {
    expect(resolveConfigEnvPlaceholders({ v: '$MWCFG_MISSING' })).toEqual({ v: '' });
  });

  it('嵌套 map / list 递归替换，数字与布尔原样透传', () => {
    process.env.MWCFG_TEST_A = 'x';
    expect(resolveConfigEnvPlaceholders({ a: [{ b: '$MWCFG_TEST_A' }], n: 3, flag: true })).toEqual(
      { a: [{ b: 'x' }], n: 3, flag: true },
    );
  });

  it('env 值再含占位符时最多解析 3 轮', () => {
    process.env.MWCFG_TEST_A = '$MWCFG_TEST_B';
    process.env.MWCFG_TEST_B = 'final';
    expect(resolveConfigEnvPlaceholders({ v: '$MWCFG_TEST_A' })).toEqual({ v: 'final' });
  });
});

describe('middlewareConfigYamlSchema', () => {
  it('各 enabled 块只接受布尔', () => {
    expect(() => middlewareConfigYamlSchema.parse({ todo: { enabled: 'yes' } })).toThrow();
    expect(middlewareConfigYamlSchema.parse({ todo: { enabled: false } })).toEqual({
      todo: { enabled: false },
    });
  });
});

describe('createDefaultMiddlewareConfigYaml', () => {
  it('SDK 默认与服务级基线逐键一致（防与提交的 config.yaml 漂移）', () => {
    expect(createDefaultMiddlewareConfigYaml()).toEqual({
      config_version: 1,
      summarization: { enabled: true, trigger_tokens: 12000, keep_messages: 8 },
      loop_detection: {
        enabled: true,
        warn_threshold: 3,
        hard_limit: 5,
        window_size: 20,
        tool_freq_warn: 30,
        tool_freq_hard_limit: 50,
      },
      guardrails: { enabled: true, block_mode: 'none' },
      title: { enabled: true },
      memory: {
        enabled: true,
        mode: 'inject',
        model_name: null,
        debounce_seconds: 30,
        max_facts: 100,
        fact_confidence_threshold: 0.7,
        injection_enabled: true,
        max_injection_tokens: 2000,
        retrieve_top_k: 8,
        retrieve_max_tokens: 800,
        semantic_match_threshold: 0.6,
        update_timeout_ms: 60000,
      },
      sandbox: { enabled: true },
      todo: { enabled: true },
      thread_data: { enabled: true },
      uploads: { enabled: true },
      subagent_limit: { enabled: true, max_concurrent: 3, max_total: 8, max_tracked_threads: 100 },
      extensions: { middlewares: [] },
    });
  });

  it('默认配置自身可通过 schema 校验（自洽）', () => {
    expect(() =>
      middlewareConfigYamlSchema.parse(createDefaultMiddlewareConfigYaml()),
    ).not.toThrow();
  });
});
