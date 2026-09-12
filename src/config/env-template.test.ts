import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * .env.example 与代码的一致性守卫。
 *
 * 起因：`_service.ts` 曾把 `DEERFLOW_EMBEDDING_*` 写成 `DEEPFLOW_EMBEDDING_*`
 * （4 处），类型检查与单测都发现不了（测试注入的是 mock 工厂），线上表现为
 * 「自定义 baseURL/模型/维度全部静默失效」。同类问题还有代码读了但模板未声明的
 * 变量（如 DEERFLOW_VISION_MAX_IMAGE_MB）——用户照模板配不全，行为与预期不符。
 */

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');
const TEMPLATE = path.join(ROOT, '.env.example');

/** 本守卫关注的变量命名空间。 */
const NAMESPACE_RE = /^(DEERFLOW|DEEPFLOW|ZHIPU)_[A-Z0-9_]+$/;
/** 已知且**故意**不在模板里的变量（留空数组即"必须全部声明"）。 */
const ALLOWLIST = new Set<string>([]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    // 测试文件自身会 stub env，不参与「模板必须声明」的约束
    else if (
      entry.isFile() &&
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** 收集 src 中被 process.env.<NAME> 静态引用的命名空间变量。 */
function collectReferenced(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(SRC_DIR)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      const name = m[1];
      if (!NAMESPACE_RE.test(name)) continue;
      const rel = path.relative(ROOT, file);
      const list = found.get(name) ?? [];
      if (!list.includes(rel)) list.push(rel);
      found.set(name, list);
    }
  }
  return found;
}

/** 解析 .env.example 中声明的变量名（含注释掉的模板行不计数）。 */
function collectDeclared(): Set<string> {
  const declared = new Set<string>();
  for (const line of fs.readFileSync(TEMPLATE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m) declared.add(m[1]);
  }
  return declared;
}

describe('.env.example 与代码引用一致', () => {
  const referenced = collectReferenced();
  const declared = collectDeclared();

  it('扫描到的引用变量数 > 0（守卫自身有效）', () => {
    expect(referenced.size).toBeGreaterThan(10);
  });

  it('不存在 DEEPFLOW_ 前缀的拼写错误（应为 DEERFLOW_）', () => {
    const typos = [...referenced.keys()].filter((n) => n.startsWith('DEEPFLOW_'));
    const detail = typos.map((n) => `${n} ← ${referenced.get(n)!.join(', ')}`).join('\n');
    expect(typos, `疑似拼写错误（应为 DEERFLOW_）：\n${detail}`).toEqual([]);
  });

  it('代码引用的每个命名空间变量都在 .env.example 中声明', () => {
    const missing = [...referenced.keys()]
      .filter((n) => !declared.has(n) && !ALLOWLIST.has(n))
      .sort();
    const detail = missing.map((n) => `${n} ← ${referenced.get(n)!.join(', ')}`).join('\n');
    expect(missing, `以下变量代码已读取但 .env.example 未声明：\n${detail}`).toEqual([]);
  });
});
