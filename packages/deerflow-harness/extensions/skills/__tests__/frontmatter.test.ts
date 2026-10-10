/**
 * frontmatter 极简解析器测试：顶层 key:value 行为锁定。
 */

import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from '../frontmatter';

describe('parseFrontmatter', () => {
  it('解析顶层字段并 trim body', () => {
    const parsed = parseFrontmatter(
      '---\nname: demo\ndescription: "A demo skill"\nlicense: MIT\n---\n\n# Title\n\nBody text\n',
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.fields).toEqual({
      name: 'demo',
      description: 'A demo skill',
      license: 'MIT',
    });
    expect(parsed?.body).toBe('# Title\n\nBody text');
  });

  it('无 frontmatter 块返回 null', () => {
    expect(parseFrontmatter('# Just a heading\n\nbody')).toBeNull();
  });

  it('块内无任何行（--- 紧邻 ---）不构成 frontmatter，返回 null', () => {
    // 该输入缺 name/description，本就不可能是合法 skill；不为此放宽解析器
    expect(parseFrontmatter('---\n---\n\nbody')).toBeNull();
  });

  it('跳过嵌套映射与列表项（metadata 父键空值一并跳过）', () => {
    const parsed = parseFrontmatter(
      '---\nname: demo\ndescription: d\nmetadata:\n  author: someone\n  version: "1.0.0"\n- list item\n---\n\nbody',
    );
    expect(parsed?.fields).toEqual({ name: 'demo', description: 'd' });
  });

  it('空值键（嵌套映射父键）不进入 fields', () => {
    const parsed = parseFrontmatter('---\nname: demo\ndescription: d\ncompatibility:\n---\n\nbody');
    expect(parsed?.fields).toEqual({ name: 'demo', description: 'd' });
  });

  it('单引号同样剥除', () => {
    const parsed = parseFrontmatter("---\nname: demo\ndescription: 'quoted'\n---\n\nbody");
    expect(parsed?.fields.description).toBe('quoted');
  });

  it('容忍 CRLF 与 BOM', () => {
    const parsed = parseFrontmatter('﻿---\r\nname: demo\r\ndescription: d\r\n---\r\n\r\nbody');
    expect(parsed?.fields).toEqual({ name: 'demo', description: 'd' });
    expect(parsed?.body).toBe('body');
  });
});
