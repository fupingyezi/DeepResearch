import { describe, expect, it } from 'vitest';

import { casefold } from './casefold';

describe('casefold', () => {
  it('普通大小写等价于小写；中文与无大小写字符原样保留', () => {
    expect(casefold('Hello WORLD')).toBe('hello world');
    expect(casefold('记忆检索 Memory')).toBe('记忆检索 memory');
    expect(casefold('①１２３')).toBe('①１２３');
    expect(casefold('emoji 🚀 不变')).toBe('emoji 🚀 不变');
  });

  it('ß/ẞ 折成 ss（toLowerCase 做不到）', () => {
    expect(casefold('Straße')).toBe('strasse');
    expect(casefold('STRASSE')).toBe('strasse');
    expect(casefold('ẞ')).toBe('ss'); // ẞ LATIN CAPITAL LETTER SHARP S
    expect(casefold('Straße')).toBe(casefold('STRASSE'));
  });

  it('连字展开：ﬁ → fi', () => {
    expect(casefold('ﬁle')).toBe('file');
    expect(casefold('ﬃ')).toBe('ffi'); // ﬃ
    expect(casefold('ﬅ')).toBe('st'); // ﬅ
  });

  it('希腊语词尾 ς 归一成 σ（覆盖 toLowerCase 的 Final_Sigma 上下文）', () => {
    expect(casefold('ς')).toBe('σ');
    expect(casefold('Σ')).toBe('σ');
    // 'ΟΔΟΣ'.toLowerCase() === 'οδος'（JS 按上下文产出词尾 ς），casefold 要归一
    expect(casefold('ΟΔΟΣ')).toBe('οδοσ');
    expect(casefold('ΟΔΟΣ')).toBe(casefold('οδος'));
  });

  it('兼容字符与 i 类特例', () => {
    expect(casefold('µ')).toBe('μ'); // MICRO SIGN → GREEK SMALL LETTER MU
    expect(casefold('K')).toBe('k'); // KELVIN SIGN
    expect(casefold('Å')).toBe('å'); // ANGSTROM SIGN → å
    expect(casefold('İ')).toBe('i̇'); // İ → i + 组合点（与 Python casefold 一致）
    expect(casefold('I')).toBe('i');
  });

  it('罕见表的抽样：二合字母、希腊语 ypogegrammeni、Cherokee、ŉ', () => {
    expect(casefold('Ǆ')).toBe('ǆ');
    expect(casefold('ǅ')).toBe('ǆ');
    expect(casefold('ᾼ')).toBe('αι'); // U+1FBC → α + ι
    expect(casefold('ꭰ')).toBe('Ꭰ'); // CHEROKEE SMALL LETTER A → 大写
    expect(casefold('ŉ')).toBe('ʼn'); // U+0149 → ʼ + n
  });

  it('不做归一化（与 Python 对齐；归一化由调用方按需叠加）', () => {
    // 用转义序列写，避免正则/编辑器把两种写法悄悄归一成同一种
    const composed = 'caf\u00e9'; // é：U+00E9 预组合
    const decomposed = 'cafe\u0301'; // e + U+0301 组合尖音符
    expect(casefold(composed)).not.toBe(casefold(decomposed));
    expect(casefold(composed).normalize('NFC')).toBe(casefold(decomposed).normalize('NFC'));
  });

  it('幂等：折叠结果再过一遍不变（去重键的稳定性要求）', () => {
    for (const s of ['Straße', 'ﬁle', 'ΟΔΟΣ', 'İ', '中 文 Test', 'ﬃß']) {
      const once = casefold(s);
      expect(casefold(once)).toBe(once);
      expect(casefold(s.toLowerCase())).toBe(once);
    }
  });
});
