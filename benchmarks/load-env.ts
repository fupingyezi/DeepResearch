/**
 * Env 加载器 — 必须在所有其他 benchmark 模块之前 import
 *
 * 原因：ES import 会被 hoist 到模块顶部。
 * 如果把 loadDotEnv 写在 run.ts 里，它会在 import config 之后才执行，
 * 而 config.ts 的 defaultConfig 在 import 时就读取了 process.env（此时为空）。
 *
 * 解决方案：提取到独立文件，作为 run.ts 的第一个 import，
 * 利用 import 的声明顺序保证此模块的副作用最先执行。
 */

import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import fs from 'fs';

function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // 去除引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // 不覆盖已有值（允许外部注入优先）
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// 加载顺序：benchmarks/.env.local 优先 > 根目录 .env.local fallback
loadDotEnv(__dirname + '/.env.local');
loadDotEnv(process.cwd() + '/.env.local');

if (process.env.BENCHMARK_VERBOSE === 'true') {
  console.log('[load-env] 已加载环境变量:', {
    BENCHMARK_AGENT_MODEL: process.env.BENCHMARK_AGENT_MODEL,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ? '**已设置**' : '(空)',
    LANGCHAIN_API_KEY: process.env.LANGCHAIN_API_KEY ? '**已设置**' : '(空)',
    TAVILY_API_KEY: process.env.TAVILY_API_KEY ? '**已设置**' : '(空)',
  });
}
