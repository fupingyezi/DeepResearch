import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildClientOptionsFromYaml,
  buildMiddlewareConfigSnapshot,
  buildMiddlewareOptionsFromYaml,
  getDeerflowConfigStore,
  resetDeerflowConfigStore,
} from '../deerflow-config';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deerflow-config-'));
  process.env.DEERFLOW_CONFIG_PATH = path.join(tmpDir, 'config.yaml');
  resetDeerflowConfigStore();
});

afterEach(async () => {
  delete process.env.DEERFLOW_CONFIG_PATH;
  resetDeerflowConfigStore();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const configPath = () => process.env.DEERFLOW_CONFIG_PATH!;
const writeConfig = (text: string) => fs.writeFile(configPath(), text, 'utf-8');
/** mtime 粗粒度（ms 级）下快速连续写可能撞同一 mtimeMs → 显式前拨保证缓存失效。 */
const bumpMtime = async () => {
  const t = new Date(Date.now() + 5000);
  await fs.utimes(configPath(), t, t);
};

describe('DeerflowConfigStore', () => {
  it('文件缺失 → SDK 默认 + fromFile:false + 空签名', async () => {
    const { config, signature, fromFile } = await getDeerflowConfigStore().loadWithSignature();
    expect(fromFile).toBe(false);
    expect(signature).toBe('');
    // 默认装配 = 服务级开关全开（与 config.yaml 提交值同源，逐键锁定见 harness 测试）
    expect(config.guardrails).toEqual({ enabled: true, block_mode: 'none' });
    expect(config.memory.enabled).toBe(true);
    expect(config.memory.mode).toBe('inject');
    expect(config.subagent_limit.max_total).toBe(8);
    expect(config.extensions.middlewares).toEqual([]);
  });

  it('mtime 未变 → 命中缓存，同一引用', async () => {
    await writeConfig('title:\n  enabled: false\n');
    const store = getDeerflowConfigStore();
    const first = await store.loadWithSignature();
    const second = await store.loadWithSignature();
    expect(second.config).toBe(first.config);
    expect(second.signature).toBe(first.signature);
    expect(second.config.title.enabled).toBe(false);
  });

  it('mtime 未变时内容变化也走缓存（mtime 是唯一失效信号）', async () => {
    // 固定整数毫秒时间戳：避开 fs 真实 mtime 的亚毫秒精度，utimes 拨回可精确命中
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    await writeConfig('title:\n  enabled: true\n');
    await fs.utimes(configPath(), t0, t0);
    const store = getDeerflowConfigStore();
    const first = await store.loadWithSignature();

    await writeConfig('title:\n  enabled: false\n');
    await fs.utimes(configPath(), t0, t0);
    const second = await store.loadWithSignature();
    expect(second.config).toBe(first.config);
    expect(second.config.title.enabled).toBe(true);
  });

  it('mtime 变化 → 重读重解析，签名变化', async () => {
    await writeConfig('title:\n  enabled: true\n');
    const store = getDeerflowConfigStore();
    const first = await store.loadWithSignature();
    expect(first.signature).toMatch(/^\d+\.?\d*:[0-9a-f]{16}$/);

    await writeConfig('title:\n  enabled: false\n');
    await bumpMtime();
    const second = await store.loadWithSignature();
    expect(second.config).not.toBe(first.config);
    expect(second.signature).not.toBe(first.signature);
    expect(second.config.title.enabled).toBe(false);
  });

  it('非法 YAML → throw 且信息带完整路径', async () => {
    await writeConfig('guardrails: [unclosed\n');
    await expect(getDeerflowConfigStore().loadWithSignature()).rejects.toThrow(
      /invalid config file: .*config\.yaml/,
    );
  });

  it('未知键 → throw（strict schema，拒绝静默吞配置）', async () => {
    await writeConfig('guardrails:\n  enabled: true\n  block_mode: none\n  typo_key: 1\n');
    await expect(getDeerflowConfigStore().loadWithSignature()).rejects.toThrow(
      /invalid config file/,
    );
  });

  it('部分块缺失 → 逐块回落默认，其余块生效', async () => {
    await writeConfig('guardrails:\n  enabled: false\n  block_mode: injection\n');
    const { config } = await getDeerflowConfigStore().loadWithSignature();
    expect(config.guardrails.enabled).toBe(false);
    expect(config.guardrails.block_mode).toBe('injection');
    // 未声明的块回落默认
    expect(config.memory.enabled).toBe(true);
    expect(config.loop_detection.hard_limit).toBe(5);
    expect(config.subagent_limit.max_total).toBe(8);
  });

  it('$VAR 占位符按 process.env 替换（未命中 → 空串）', async () => {
    process.env.DEERFLOW_TEST_MEMORY_MODEL = 'qwen-max';
    try {
      await writeConfig('memory:\n  enabled: true\n  model_name: $DEERFLOW_TEST_MEMORY_MODEL\n');
      const { config } = await getDeerflowConfigStore().loadWithSignature();
      expect(config.memory.model_name).toBe('qwen-max');
    } finally {
      delete process.env.DEERFLOW_TEST_MEMORY_MODEL;
    }
  });
});

describe('buildClientOptionsFromYaml', () => {
  it('逐键映射到 ClientOptions', async () => {
    await writeConfig(
      [
        'guardrails:',
        '  enabled: false',
        '  block_mode: all',
        'subagent_limit:',
        '  max_total: 4',
        'loop_detection:',
        '  hard_limit: 7',
        'summarization:',
        '  trigger_tokens: 20000',
        'memory:',
        '  mode: retrieve',
        '',
      ].join('\n'),
    );
    const { config } = await getDeerflowConfigStore().loadWithSignature();
    const opts = buildClientOptionsFromYaml(config);

    expect(opts.agentName).toBe('lead');
    expect(opts.memoryEnabled).toBe(true);
    expect(opts.memoryMode).toBe('retrieve');
    expect(opts.autoTitleEnabled).toBe(true);
    expect(opts.threadDataEnabled).toBe(true);
    expect(opts.uploadsEnabled).toBe(true);
    expect(opts.sandboxEnabled).toBe(true);
    expect(opts.summarizationEnabled).toBe(true);
    expect(opts.guardrailEnabled).toBe(false);
    expect(opts.todoEnabled).toBe(true);

    expect(opts.guardrail).toEqual({ enabled: false, blockMode: 'all' });
    expect(opts.subagentLimit).toMatchObject({ enabled: true, maxTotal: 4 });
    expect(opts.loopDetection).toMatchObject({ enabled: true, hardLimit: 7 });
    expect(opts.summarization).toMatchObject({ triggerTokens: 20000 });
  });
});

describe('buildMiddlewareOptionsFromYaml / buildMiddlewareConfigSnapshot', () => {
  it('options 全键映射 + snapshot 组合', async () => {
    await writeConfig(
      [
        'guardrails:',
        '  enabled: false',
        '  block_mode: injection',
        'subagent_limit:',
        '  enabled: false',
        '  max_concurrent: 2',
        'loop_detection:',
        '  enabled: false',
        '  warn_threshold: 4',
        'summarization:',
        '  enabled: false',
        '  keep_messages: 16',
        'memory:',
        '  enabled: false',
        '  mode: retrieve',
        'todo:',
        '  enabled: false',
        '',
      ].join('\n'),
    );
    const { config } = await getDeerflowConfigStore().loadWithSignature();

    const options = buildMiddlewareOptionsFromYaml(config);
    expect(options.guardrail).toEqual({ enabled: false, blockMode: 'injection' });
    expect(options.subagentLimit).toMatchObject({ enabled: false, maxConcurrent: 2 });
    expect(options.loopDetection).toMatchObject({ enabled: false, warnThreshold: 4 });
    expect(options.summarization).toMatchObject({ keepMessages: 16 });

    const snap = buildMiddlewareConfigSnapshot(config, 'sig-x');
    expect(snap.signature).toBe('sig-x');
    expect(snap.enabled.guardrail).toBe(false);
    expect('subagentLimit' in snap.enabled).toBe(false); // 恒开，不在 enabled 面
    expect(snap.enabled.memory).toBe(false);
    expect(snap.enabled.todo).toBe(false);
    expect(snap.memoryMode).toBe('retrieve');
    expect(snap.options).toEqual(options);
  });
});
