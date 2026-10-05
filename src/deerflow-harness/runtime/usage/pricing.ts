/**
 * LLM 计价 —— 把 `usage-accounting.ts` 记下的 token 换算成钱。
 *
 * 设计要点：
 *
 * - **数据与逻辑分离**：单价全部在 `pricing.json` 里（含 `asOf` 与官方 URL），价格变动
 *   只改那一个文件，不动代码。解析失败**直接抛错**，不静默退回默认价 —— 算错钱比不算
 *   更糟。
 * - **未知模型返回 `undefined`**，绝不猜价。报告里会列进 `unknownModels` 并只出 token。
 * - **三个价格维度都影响结果**，缺一不可：① 缓存命中 vs 未命中（单价可差 50 倍）；
 *   ② 高峰 vs 空闲（空闲恰为高峰半价）；③ 输出含 reasoning（DeepSeek 两档默认都走
 *   思考模式，实测 flash 也产生 `reasoning_tokens`）。时段按**每次调用自己的时间戳**
 *   判定，跨时段的长 run 不会被一刀切。
 * - `cacheReadTokens` 是 `inputTokens` 的**子集**，未命中量 = input − cacheRead。
 */

import type { RunUsage, TokenUsage } from './usage-accounting';

import rawPriceTable from './pricing.json';

export interface ModelPrice {
  /** 命中 prompt cache 的输入单价。 */
  cacheHit: number;
  /** 未命中缓存的输入单价。 */
  cacheMiss: number;
  /** 输出单价（reasoning 计入输出）。 */
  output: number;
}

export interface PriceTable {
  /** 价格数据截止日期（YYYY-MM-DD），用于判断是否该复核。 */
  asOf: string;
  /** 官方定价页 URL。 */
  source: string;
  currency: string;
  unit: string;
  peakWindow: {
    /** 高峰时段判定的时区（DeepSeek 按北京时间定义）。 */
    timeZone: string;
    /** 高峰生效的星期（0=周日 … 6=周六）。 */
    weekdays: number[];
    /** 高峰时段区间，`[起, 止)` 半开，格式 `HH:mm`。 */
    ranges: Array<[string, string]>;
  };
  models: Record<string, { offPeak: ModelPrice; peak: ModelPrice }>;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function requireNumber(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`[pricing] ${path} 必须是有限数字，实际为 ${JSON.stringify(v)}`);
  }
  return v;
}

function requireString(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`[pricing] ${path} 必须是非空字符串，实际为 ${JSON.stringify(v)}`);
  }
  return v;
}

function parseModelPrice(v: unknown, path: string): ModelPrice {
  if (!isObject(v)) throw new Error(`[pricing] ${path} 必须是对象`);
  return {
    cacheHit: requireNumber(v.cacheHit, `${path}.cacheHit`),
    cacheMiss: requireNumber(v.cacheMiss, `${path}.cacheMiss`),
    output: requireNumber(v.output, `${path}.output`),
  };
}

/** 校验并规范化价格表；任何缺漏都抛错（不静默退回默认价）。 */
export function parsePriceTable(raw: unknown): PriceTable {
  if (!isObject(raw)) throw new Error('[pricing] 价格表根节点必须是对象');
  const peakWindowRaw = raw.peakWindow;
  if (!isObject(peakWindowRaw)) throw new Error('[pricing] peakWindow 必须是对象');

  const weekdays = peakWindowRaw.weekdays;
  if (!Array.isArray(weekdays) || weekdays.some((d) => typeof d !== 'number')) {
    throw new Error('[pricing] peakWindow.weekdays 必须是数字数组（0=周日 … 6=周六）');
  }
  const ranges = peakWindowRaw.ranges;
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new Error('[pricing] peakWindow.ranges 必须是非空数组');
  }
  const parsedRanges: Array<[string, string]> = ranges.map((r, i) => {
    if (!Array.isArray(r) || r.length !== 2) {
      throw new Error(`[pricing] peakWindow.ranges[${i}] 必须是 [起, 止] 两元组`);
    }
    return [
      requireString(r[0], `peakWindow.ranges[${i}][0]`),
      requireString(r[1], `peakWindow.ranges[${i}][1]`),
    ];
  });

  const modelsRaw = raw.models;
  if (!isObject(modelsRaw)) throw new Error('[pricing] models 必须是对象');
  const models: PriceTable['models'] = {};
  for (const [name, entry] of Object.entries(modelsRaw)) {
    if (!isObject(entry)) throw new Error(`[pricing] models.${name} 必须是对象`);
    models[name] = {
      offPeak: parseModelPrice(entry.offPeak, `models.${name}.offPeak`),
      peak: parseModelPrice(entry.peak, `models.${name}.peak`),
    };
  }
  if (Object.keys(models).length === 0) throw new Error('[pricing] models 不能为空');

  return {
    asOf: requireString(raw.asOf, 'asOf'),
    source: requireString(raw.source, 'source'),
    currency: requireString(raw.currency, 'currency'),
    unit: requireString(raw.unit, 'unit'),
    peakWindow: {
      timeZone: requireString(peakWindowRaw.timeZone, 'peakWindow.timeZone'),
      weekdays: weekdays as number[],
      ranges: parsedRanges,
    },
    models,
  };
}

/** 内置价格表（来自 `pricing.json`）。 */
export const PRICE_TABLE: PriceTable = parsePriceTable(rawPriceTable);

// Intl.DateTimeFormat 构造不便宜，按 timeZone 记忆化。
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    // h23 避免某些实现在 0 点返回 "24"
    hourCycle: 'h23',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** 把时刻换算到价格表所在时区的「星期 + 当天第几分钟」。 */
export function zonedClock(at: Date, timeZone: string): { weekday: number; minutesOfDay: number } {
  const parts = formatterFor(timeZone).formatToParts(at);
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = WEEKDAY_INDEX[pick('weekday')] ?? 0;
  const minutesOfDay = Number(pick('hour')) * 60 + Number(pick('minute'));
  return { weekday, minutesOfDay };
}

function parseHm(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`[pricing] 无法解析时刻 "${value}"，期望 HH:mm`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 该时刻是否落在高峰时段（区间半开：09:00 起算，12:00 起不算）。 */
export function isPeakPeriod(at: Date, table: PriceTable = PRICE_TABLE): boolean {
  const { weekday, minutesOfDay } = zonedClock(at, table.peakWindow.timeZone);
  if (!table.peakWindow.weekdays.includes(weekday)) return false;
  return table.peakWindow.ranges.some(([start, end]) => {
    const from = parseHm(start);
    const to = parseHm(end);
    return minutesOfDay >= from && minutesOfDay < to;
  });
}

export interface CostBreakdown {
  /** 命中缓存的输入花费。 */
  cacheHit: number;
  /** 未命中缓存的输入花费。 */
  cacheMiss: number;
  /** 输出花费。 */
  output: number;
  total: number;
  /** 计价所用时段。 */
  peak: boolean;
  currency: string;
}

function priceFor(table: PriceTable, modelName: string, peak: boolean): ModelPrice | undefined {
  const entry = table.models[modelName];
  if (!entry) return undefined;
  return peak ? entry.peak : entry.offPeak;
}

function breakdownOf(
  usage: TokenUsage,
  price: ModelPrice,
  peak: boolean,
  currency: string,
): CostBreakdown {
  const perMillion = 1_000_000;
  // cacheRead 是 input 的子集，未命中量必须减掉，否则命中部分被按未命中价重复计费。
  const missedInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
  const cacheHit = (usage.cacheReadTokens / perMillion) * price.cacheHit;
  const cacheMiss = (missedInput / perMillion) * price.cacheMiss;
  const output = (usage.outputTokens / perMillion) * price.output;
  return {
    cacheHit,
    cacheMiss,
    output,
    total: cacheHit + cacheMiss + output,
    peak,
    currency,
  };
}

/**
 * 单次调用的费用。模型不在价格表里时返回 `undefined`（**绝不猜价**）。
 */
export function computeCallCost(
  usage: TokenUsage,
  modelName: string,
  at: Date | number,
  table: PriceTable = PRICE_TABLE,
): CostBreakdown | undefined {
  const peak = isPeakPeriod(new Date(at), table);
  const price = priceFor(table, modelName, peak);
  if (!price) return undefined;
  return breakdownOf(usage, price, peak, table.currency);
}

export interface UsageCost {
  currency: string;
  priceAsOf: string;
  priceSource: string;
  /** 按每次调用**实际时刻**计价的总和。 */
  total: number;
  byModel: Record<string, number>;
  /** 出现在用量里但价格表没有的模型 —— 它们的费用**未计入** `total`。 */
  unknownModels: string[];
  peakCalls: number;
  offPeakCalls: number;
  /** 全部调用若都落在高峰时段的总价（现实上界，用于说明时段选择的影响）。 */
  ifAllPeak: number;
  /** 拿不到用量的调用数（费用被低估）。 */
  callsMissingUsage: number;
  /** 只有粗粒度用量的调用数（缓存命中体现不出来，费用被高估）。 */
  callsCoarseUsage: number;
}

/** 汇总一个记账作用域的用量为费用。 */
export function computeRunCost(usage: RunUsage, table: PriceTable = PRICE_TABLE): UsageCost {
  const byModel: Record<string, number> = {};
  const unknown = new Set<string>();
  let total = 0;
  let ifAllPeak = 0;
  let peakCalls = 0;
  let offPeakCalls = 0;

  for (const call of usage.calls) {
    const entry = table.models[call.modelName];
    if (!entry) {
      unknown.add(call.modelName);
      continue;
    }
    const peak = isPeakPeriod(new Date(call.at), table);
    const actual = breakdownOf(call.usage, peak ? entry.peak : entry.offPeak, peak, table.currency);
    const upper = breakdownOf(call.usage, entry.peak, true, table.currency);

    if (peak) peakCalls += 1;
    else offPeakCalls += 1;

    total += actual.total;
    ifAllPeak += upper.total;
    byModel[call.modelName] = (byModel[call.modelName] ?? 0) + actual.total;
  }

  return {
    currency: table.currency,
    priceAsOf: table.asOf,
    priceSource: table.source,
    total,
    byModel,
    unknownModels: [...unknown],
    peakCalls,
    offPeakCalls,
    ifAllPeak,
    callsMissingUsage: usage.callsMissingUsage,
    callsCoarseUsage: usage.callsCoarseUsage,
  };
}
