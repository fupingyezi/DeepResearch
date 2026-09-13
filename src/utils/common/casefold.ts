/**
 * Unicode case folding（等价于 Python 的 `str.casefold()`）。
 *
 * 为什么不用 `toLowerCase()` / `toLocaleLowerCase()`：
 *   - `toLowerCase()` 只是 Unicode 默认小写映射，与 casefold 在 183 个码位上不同
 *     （ß 折成 ss、ﬁ 折成 fi、ς 归一成 σ …）。拿它当去重键，「Straße」和「STRASSE」
 *     会被判成两条不同的记录；
 *   - `toLocaleLowerCase()` 更糟：结果随宿主 locale 漂移（土耳其语环境把 I 折成 ı），
 *     同一份数据在不同机器上得到不同的键。
 *
 * 分工：普通的「大写 → 小写」简单大小写对交给运行期引擎的 `toLowerCase()`（引擎的
 * 数据会随 Node 升级持续补齐新字符）；本表只负责 casefold 特有的**全量**折叠
 * —— 多字符展开（ß→ss、ﬁ→fi）、ς→σ 这类归一、以及小写但不等价的兼容字符。
 * 两边都覆盖不到的只有「引擎 Unicode 比本表更旧」时新字符的简单大小写对：那时它们
 * 原样返回，不会误折。
 *
 * 实现 = `toLowerCase()` 之后按残差表逐码位替换。残差表 = 全部「折叠结果 ≠ 自身、
 * 但自身已是小写」的码位。已对 Unicode 16.0.0 的全部码位（1557 个可折叠码位 +
 * 其余不变码位）与 Python `str.casefold()` 逐一比对，结果完全一致；表中 value 全是
 * 折叠不动点（value 不含任何 key，故一次替换即收敛）。逐字符折叠对整串同样成立：
 * casefold 无上下文规则，而 `toLowerCase()` 唯一的上下文规则（希腊语词尾 ς）恰好被
 * ς → σ 这条残差覆盖。
 *
 * 表数据取自 Unicode CaseFolding.txt 的 C + F（全量）折叠，不含 Turkic 变体。
 * 重新生成（Python 的 Unicode 版本需与 TS 运行期一致）：
 *
 *   python3 -c "import unicodedata as u; [print('  [0x%04x, %r],' % (cp, chr(cp).casefold())) \
 *   for cp in range(0x110000) if u.category(chr(cp)) != 'Cn' and chr(cp).casefold() != chr(cp) \
 *   and chr(cp).lower() == chr(cp)]"
 */

/** [原码位, 折叠结果]，value 均为折叠不动点（见表头）。 */
const SPECIAL_FOLDINGS: ReadonlyArray<readonly [from: number, to: string]> = [
  [0x00b5, '\u03bc'], // U+00B5 → U+03BC
  [0x00df, 'ss'], // U+00DF → U+0073 U+0073
  [0x0149, '\u02bcn'], // U+0149 → U+02BC U+006E
  [0x017f, 's'], // U+017F → U+0073
  [0x01f0, 'j\u030c'], // U+01F0 → U+006A U+030C
  [0x0345, '\u03b9'], // U+0345 → U+03B9
  [0x0390, '\u03b9\u0308\u0301'], // U+0390 → U+03B9 U+0308 U+0301
  [0x03b0, '\u03c5\u0308\u0301'], // U+03B0 → U+03C5 U+0308 U+0301
  [0x03c2, '\u03c3'], // U+03C2 → U+03C3
  [0x03d0, '\u03b2'], // U+03D0 → U+03B2
  [0x03d1, '\u03b8'], // U+03D1 → U+03B8
  [0x03d5, '\u03c6'], // U+03D5 → U+03C6
  [0x03d6, '\u03c0'], // U+03D6 → U+03C0
  [0x03f0, '\u03ba'], // U+03F0 → U+03BA
  [0x03f1, '\u03c1'], // U+03F1 → U+03C1
  [0x03f5, '\u03b5'], // U+03F5 → U+03B5
  [0x0587, '\u0565\u0582'], // U+0587 → U+0565 U+0582
  [0x13f8, '\u13f0'], // U+13F8 → U+13F0
  [0x13f9, '\u13f1'], // U+13F9 → U+13F1
  [0x13fa, '\u13f2'], // U+13FA → U+13F2
  [0x13fb, '\u13f3'], // U+13FB → U+13F3
  [0x13fc, '\u13f4'], // U+13FC → U+13F4
  [0x13fd, '\u13f5'], // U+13FD → U+13F5
  [0x1c80, '\u0432'], // U+1C80 → U+0432
  [0x1c81, '\u0434'], // U+1C81 → U+0434
  [0x1c82, '\u043e'], // U+1C82 → U+043E
  [0x1c83, '\u0441'], // U+1C83 → U+0441
  [0x1c84, '\u0442'], // U+1C84 → U+0442
  [0x1c85, '\u0442'], // U+1C85 → U+0442
  [0x1c86, '\u044a'], // U+1C86 → U+044A
  [0x1c87, '\u0463'], // U+1C87 → U+0463
  [0x1c88, '\ua64b'], // U+1C88 → U+A64B
  [0x1e96, 'h\u0331'], // U+1E96 → U+0068 U+0331
  [0x1e97, 't\u0308'], // U+1E97 → U+0074 U+0308
  [0x1e98, 'w\u030a'], // U+1E98 → U+0077 U+030A
  [0x1e99, 'y\u030a'], // U+1E99 → U+0079 U+030A
  [0x1e9a, 'a\u02be'], // U+1E9A → U+0061 U+02BE
  [0x1e9b, '\u1e61'], // U+1E9B → U+1E61
  [0x1f50, '\u03c5\u0313'], // U+1F50 → U+03C5 U+0313
  [0x1f52, '\u03c5\u0313\u0300'], // U+1F52 → U+03C5 U+0313 U+0300
  [0x1f54, '\u03c5\u0313\u0301'], // U+1F54 → U+03C5 U+0313 U+0301
  [0x1f56, '\u03c5\u0313\u0342'], // U+1F56 → U+03C5 U+0313 U+0342
  [0x1f80, '\u1f00\u03b9'], // U+1F80 → U+1F00 U+03B9
  [0x1f81, '\u1f01\u03b9'], // U+1F81 → U+1F01 U+03B9
  [0x1f82, '\u1f02\u03b9'], // U+1F82 → U+1F02 U+03B9
  [0x1f83, '\u1f03\u03b9'], // U+1F83 → U+1F03 U+03B9
  [0x1f84, '\u1f04\u03b9'], // U+1F84 → U+1F04 U+03B9
  [0x1f85, '\u1f05\u03b9'], // U+1F85 → U+1F05 U+03B9
  [0x1f86, '\u1f06\u03b9'], // U+1F86 → U+1F06 U+03B9
  [0x1f87, '\u1f07\u03b9'], // U+1F87 → U+1F07 U+03B9
  [0x1f90, '\u1f20\u03b9'], // U+1F90 → U+1F20 U+03B9
  [0x1f91, '\u1f21\u03b9'], // U+1F91 → U+1F21 U+03B9
  [0x1f92, '\u1f22\u03b9'], // U+1F92 → U+1F22 U+03B9
  [0x1f93, '\u1f23\u03b9'], // U+1F93 → U+1F23 U+03B9
  [0x1f94, '\u1f24\u03b9'], // U+1F94 → U+1F24 U+03B9
  [0x1f95, '\u1f25\u03b9'], // U+1F95 → U+1F25 U+03B9
  [0x1f96, '\u1f26\u03b9'], // U+1F96 → U+1F26 U+03B9
  [0x1f97, '\u1f27\u03b9'], // U+1F97 → U+1F27 U+03B9
  [0x1fa0, '\u1f60\u03b9'], // U+1FA0 → U+1F60 U+03B9
  [0x1fa1, '\u1f61\u03b9'], // U+1FA1 → U+1F61 U+03B9
  [0x1fa2, '\u1f62\u03b9'], // U+1FA2 → U+1F62 U+03B9
  [0x1fa3, '\u1f63\u03b9'], // U+1FA3 → U+1F63 U+03B9
  [0x1fa4, '\u1f64\u03b9'], // U+1FA4 → U+1F64 U+03B9
  [0x1fa5, '\u1f65\u03b9'], // U+1FA5 → U+1F65 U+03B9
  [0x1fa6, '\u1f66\u03b9'], // U+1FA6 → U+1F66 U+03B9
  [0x1fa7, '\u1f67\u03b9'], // U+1FA7 → U+1F67 U+03B9
  [0x1fb2, '\u1f70\u03b9'], // U+1FB2 → U+1F70 U+03B9
  [0x1fb3, '\u03b1\u03b9'], // U+1FB3 → U+03B1 U+03B9
  [0x1fb4, '\u03ac\u03b9'], // U+1FB4 → U+03AC U+03B9
  [0x1fb6, '\u03b1\u0342'], // U+1FB6 → U+03B1 U+0342
  [0x1fb7, '\u03b1\u0342\u03b9'], // U+1FB7 → U+03B1 U+0342 U+03B9
  [0x1fbe, '\u03b9'], // U+1FBE → U+03B9
  [0x1fc2, '\u1f74\u03b9'], // U+1FC2 → U+1F74 U+03B9
  [0x1fc3, '\u03b7\u03b9'], // U+1FC3 → U+03B7 U+03B9
  [0x1fc4, '\u03ae\u03b9'], // U+1FC4 → U+03AE U+03B9
  [0x1fc6, '\u03b7\u0342'], // U+1FC6 → U+03B7 U+0342
  [0x1fc7, '\u03b7\u0342\u03b9'], // U+1FC7 → U+03B7 U+0342 U+03B9
  [0x1fd2, '\u03b9\u0308\u0300'], // U+1FD2 → U+03B9 U+0308 U+0300
  [0x1fd3, '\u03b9\u0308\u0301'], // U+1FD3 → U+03B9 U+0308 U+0301
  [0x1fd6, '\u03b9\u0342'], // U+1FD6 → U+03B9 U+0342
  [0x1fd7, '\u03b9\u0308\u0342'], // U+1FD7 → U+03B9 U+0308 U+0342
  [0x1fe2, '\u03c5\u0308\u0300'], // U+1FE2 → U+03C5 U+0308 U+0300
  [0x1fe3, '\u03c5\u0308\u0301'], // U+1FE3 → U+03C5 U+0308 U+0301
  [0x1fe4, '\u03c1\u0313'], // U+1FE4 → U+03C1 U+0313
  [0x1fe6, '\u03c5\u0342'], // U+1FE6 → U+03C5 U+0342
  [0x1fe7, '\u03c5\u0308\u0342'], // U+1FE7 → U+03C5 U+0308 U+0342
  [0x1ff2, '\u1f7c\u03b9'], // U+1FF2 → U+1F7C U+03B9
  [0x1ff3, '\u03c9\u03b9'], // U+1FF3 → U+03C9 U+03B9
  [0x1ff4, '\u03ce\u03b9'], // U+1FF4 → U+03CE U+03B9
  [0x1ff6, '\u03c9\u0342'], // U+1FF6 → U+03C9 U+0342
  [0x1ff7, '\u03c9\u0342\u03b9'], // U+1FF7 → U+03C9 U+0342 U+03B9
  [0xab70, '\u13a0'], // U+AB70 → U+13A0
  [0xab71, '\u13a1'], // U+AB71 → U+13A1
  [0xab72, '\u13a2'], // U+AB72 → U+13A2
  [0xab73, '\u13a3'], // U+AB73 → U+13A3
  [0xab74, '\u13a4'], // U+AB74 → U+13A4
  [0xab75, '\u13a5'], // U+AB75 → U+13A5
  [0xab76, '\u13a6'], // U+AB76 → U+13A6
  [0xab77, '\u13a7'], // U+AB77 → U+13A7
  [0xab78, '\u13a8'], // U+AB78 → U+13A8
  [0xab79, '\u13a9'], // U+AB79 → U+13A9
  [0xab7a, '\u13aa'], // U+AB7A → U+13AA
  [0xab7b, '\u13ab'], // U+AB7B → U+13AB
  [0xab7c, '\u13ac'], // U+AB7C → U+13AC
  [0xab7d, '\u13ad'], // U+AB7D → U+13AD
  [0xab7e, '\u13ae'], // U+AB7E → U+13AE
  [0xab7f, '\u13af'], // U+AB7F → U+13AF
  [0xab80, '\u13b0'], // U+AB80 → U+13B0
  [0xab81, '\u13b1'], // U+AB81 → U+13B1
  [0xab82, '\u13b2'], // U+AB82 → U+13B2
  [0xab83, '\u13b3'], // U+AB83 → U+13B3
  [0xab84, '\u13b4'], // U+AB84 → U+13B4
  [0xab85, '\u13b5'], // U+AB85 → U+13B5
  [0xab86, '\u13b6'], // U+AB86 → U+13B6
  [0xab87, '\u13b7'], // U+AB87 → U+13B7
  [0xab88, '\u13b8'], // U+AB88 → U+13B8
  [0xab89, '\u13b9'], // U+AB89 → U+13B9
  [0xab8a, '\u13ba'], // U+AB8A → U+13BA
  [0xab8b, '\u13bb'], // U+AB8B → U+13BB
  [0xab8c, '\u13bc'], // U+AB8C → U+13BC
  [0xab8d, '\u13bd'], // U+AB8D → U+13BD
  [0xab8e, '\u13be'], // U+AB8E → U+13BE
  [0xab8f, '\u13bf'], // U+AB8F → U+13BF
  [0xab90, '\u13c0'], // U+AB90 → U+13C0
  [0xab91, '\u13c1'], // U+AB91 → U+13C1
  [0xab92, '\u13c2'], // U+AB92 → U+13C2
  [0xab93, '\u13c3'], // U+AB93 → U+13C3
  [0xab94, '\u13c4'], // U+AB94 → U+13C4
  [0xab95, '\u13c5'], // U+AB95 → U+13C5
  [0xab96, '\u13c6'], // U+AB96 → U+13C6
  [0xab97, '\u13c7'], // U+AB97 → U+13C7
  [0xab98, '\u13c8'], // U+AB98 → U+13C8
  [0xab99, '\u13c9'], // U+AB99 → U+13C9
  [0xab9a, '\u13ca'], // U+AB9A → U+13CA
  [0xab9b, '\u13cb'], // U+AB9B → U+13CB
  [0xab9c, '\u13cc'], // U+AB9C → U+13CC
  [0xab9d, '\u13cd'], // U+AB9D → U+13CD
  [0xab9e, '\u13ce'], // U+AB9E → U+13CE
  [0xab9f, '\u13cf'], // U+AB9F → U+13CF
  [0xaba0, '\u13d0'], // U+ABA0 → U+13D0
  [0xaba1, '\u13d1'], // U+ABA1 → U+13D1
  [0xaba2, '\u13d2'], // U+ABA2 → U+13D2
  [0xaba3, '\u13d3'], // U+ABA3 → U+13D3
  [0xaba4, '\u13d4'], // U+ABA4 → U+13D4
  [0xaba5, '\u13d5'], // U+ABA5 → U+13D5
  [0xaba6, '\u13d6'], // U+ABA6 → U+13D6
  [0xaba7, '\u13d7'], // U+ABA7 → U+13D7
  [0xaba8, '\u13d8'], // U+ABA8 → U+13D8
  [0xaba9, '\u13d9'], // U+ABA9 → U+13D9
  [0xabaa, '\u13da'], // U+ABAA → U+13DA
  [0xabab, '\u13db'], // U+ABAB → U+13DB
  [0xabac, '\u13dc'], // U+ABAC → U+13DC
  [0xabad, '\u13dd'], // U+ABAD → U+13DD
  [0xabae, '\u13de'], // U+ABAE → U+13DE
  [0xabaf, '\u13df'], // U+ABAF → U+13DF
  [0xabb0, '\u13e0'], // U+ABB0 → U+13E0
  [0xabb1, '\u13e1'], // U+ABB1 → U+13E1
  [0xabb2, '\u13e2'], // U+ABB2 → U+13E2
  [0xabb3, '\u13e3'], // U+ABB3 → U+13E3
  [0xabb4, '\u13e4'], // U+ABB4 → U+13E4
  [0xabb5, '\u13e5'], // U+ABB5 → U+13E5
  [0xabb6, '\u13e6'], // U+ABB6 → U+13E6
  [0xabb7, '\u13e7'], // U+ABB7 → U+13E7
  [0xabb8, '\u13e8'], // U+ABB8 → U+13E8
  [0xabb9, '\u13e9'], // U+ABB9 → U+13E9
  [0xabba, '\u13ea'], // U+ABBA → U+13EA
  [0xabbb, '\u13eb'], // U+ABBB → U+13EB
  [0xabbc, '\u13ec'], // U+ABBC → U+13EC
  [0xabbd, '\u13ed'], // U+ABBD → U+13ED
  [0xabbe, '\u13ee'], // U+ABBE → U+13EE
  [0xabbf, '\u13ef'], // U+ABBF → U+13EF
  [0xfb00, 'ff'], // U+FB00 → U+0066 U+0066
  [0xfb01, 'fi'], // U+FB01 → U+0066 U+0069
  [0xfb02, 'fl'], // U+FB02 → U+0066 U+006C
  [0xfb03, 'ffi'], // U+FB03 → U+0066 U+0066 U+0069
  [0xfb04, 'ffl'], // U+FB04 → U+0066 U+0066 U+006C
  [0xfb05, 'st'], // U+FB05 → U+0073 U+0074
  [0xfb06, 'st'], // U+FB06 → U+0073 U+0074
  [0xfb13, '\u0574\u0576'], // U+FB13 → U+0574 U+0576
  [0xfb14, '\u0574\u0565'], // U+FB14 → U+0574 U+0565
  [0xfb15, '\u0574\u056b'], // U+FB15 → U+0574 U+056B
  [0xfb16, '\u057e\u0576'], // U+FB16 → U+057E U+0576
  [0xfb17, '\u0574\u056d'], // U+FB17 → U+0574 U+056D
];

const SPECIAL_FOLDING_BY_CODE_POINT: ReadonlyMap<number, string> = new Map(SPECIAL_FOLDINGS);

/**
 * Unicode 全量 case folding —— 「忽略大小写即等价」的判定 / 去重键。
 *
 * 不做 Unicode 归一化（NFC / NFD），与 Python `casefold()` 对齐：组合字符与预组合
 * 字符（é 的两种写法）在本函数下**不**相等，需要时请自行叠加 `normalize('NFC')`
 * —— 记忆去重键就在 `memory/updater.ts` 的 factContentKey 里这么做。
 */
export function casefold(input: string): string {
  let folded = '';
  for (const ch of input.toLowerCase()) {
    folded += SPECIAL_FOLDING_BY_CODE_POINT.get(ch.codePointAt(0)!) ?? ch;
  }
  return folded;
}
