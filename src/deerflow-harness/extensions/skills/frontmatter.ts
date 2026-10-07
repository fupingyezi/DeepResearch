/**
 * 最小 YAML frontmatter 解析器。
 *
 * SKILL.md frontmatter 字段简单（name / description / 可选 license），
 * 不引入 js-yaml：仅解析顶层 `key: value` 行，跳过嵌套映射（如
 * `compatibility:` 下的缩进行）与列表项。
 */

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parseFrontmatter(content: string): Frontmatter | null {
  // 正则锚定开头：带 BOM（Windows 保存常见）会导致整个 frontmatter 被跳过，先剥离
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(content.replace(/^﻿/, ''));
  if (!match) return null;

  const block = match[1];
  const body = content.slice(match[0].length);
  const fields: Record<string, string> = {};

  for (const rawLine of block.split('\n')) {
    // CRLF 行尾先剥 \r：`.` 不匹配行终止符，值尾部的 \r 会让 (.*)$ 整行失配
    // 静默跳过（CRLF 文件所有字段都会丢），必须先归一
    const line = rawLine.replace(/\r$/, '');
    // 仅解析顶层 key（无前导空白）；缩进行属于嵌套映射，忽略
    if (/^\s/.test(line)) continue;
    const fieldMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!fieldMatch) continue;
    const key = fieldMatch[1];
    const value = fieldMatch[2].trim();
    // 空值表示嵌套映射父键（如 `compatibility:`），跳过
    if (value === '') continue;
    fields[key] = stripQuotes(value);
  }

  return { fields, body: body.trim() };
}
