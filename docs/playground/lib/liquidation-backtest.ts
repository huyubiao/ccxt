import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { getBinanceLiquidationReplay } from "./binance-liquidation-levels";
import { BINANCE_MARGIN_UNAVAILABLE_MESSAGE, BinanceMarginProfileUnavailableError } from "./binance-margin-brackets";
import {
  LIQUIDATION_BACKTEST_HOURS, LIQUIDATION_BACKTEST_MS, LIQUIDATION_INTERVAL_MS,
  LIQUIDATION_SNAPSHOT_LEAD_MS, type LiquidationRiskSnapshot,
} from "./liquidation-levels";
import type { MarketInstrument } from "./market-lookup";

export const LIQUIDATION_EVENT_NOTIONAL = 10_000;
const sides = ["long", "short"] as const;
type Side = typeof sides[number];
type PricedFill = { price: number; amount: number };
type Amounts = Record<Side, number> & {
  fills?: Partial<Record<Side, PricedFill[]>>;
  missingPrices?: Partial<Record<Side, true>>;
};
type Reference = {
  source: "Swolecharts" | "CoinBoss" | "CryptoHFTData";
  status: "covered" | "partial" | "unavailable";
  intervals: Record<number, Amounts>;
  detail: string;
};

function addInterval(intervals: Reference["intervals"], time: number, long: number, short: number) {
  const start = Math.floor(time / LIQUIDATION_INTERVAL_MS) * LIQUIDATION_INTERVAL_MS;
  const interval = intervals[start] ??= { long: 0, short: 0 };
  interval.long += long;
  interval.short += short;
  return interval;
}

function addPricedLiquidation(intervals: Reference["intervals"], time: number, side: Side, amount: number, price: number) {
  const interval = addInterval(intervals, time, side === "long" ? amount : 0, side === "short" ? amount : 0);
  if (!Number.isFinite(price) || price <= 0) {
    (interval.missingPrices ??= {})[side] = true;
    return;
  }
  const fills = (interval.fills ??= {});
  (fills[side] ??= []).push({ price, amount });
}
const unavailable = (source: Reference["source"], detail: string): Reference => ({
  source, status: "unavailable", detail, intervals: {},
});

async function getJson<T>(url: URL, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Liquidation source returned HTTP ${response.status}`);
  return response.json();
}

async function swoleReference(symbol: string, from: number, to: number): Promise<Reference> {
  const market = `binance:perp:${symbol}`;
  const url = new URL("https://swolecharts.com/api/series/liquidations");
  url.search = new URLSearchParams({ market, start: String(from), end: String(to), step: "5m" }).toString();
  const data = await getJson<{ market: string; start: number; end: number; step: number; t: number[];
    long: number[]; short: number[]; gaps?: unknown[]; db?: boolean; error?: unknown }>(url, AbortSignal.timeout(10_000));
  if (data.market !== market || data.db === false || data.error || data.step !== LIQUIDATION_INTERVAL_MS || !Array.isArray(data.t) ||
    !Array.isArray(data.long) || !Array.isArray(data.short) || data.long.length !== data.t.length || data.short.length !== data.t.length) {
    return unavailable("Swolecharts", "未返回可用的币安合约 5 分钟数据。");
  }
  const intervals: Reference["intervals"] = {};
  const seen = new Set<number>();
  for (const [index, time] of data.t.entries()) {
    if (time < from || time >= to) continue;
    const a = data.long[index], b = data.short[index];
    if (!Number.isSafeInteger(time) || time % LIQUIDATION_INTERVAL_MS !== 0 || !Number.isFinite(a) || a < 0 || !Number.isFinite(b) || b < 0 || seen.has(time)) {
      return unavailable("Swolecharts", "5 分钟数据包含无效或重复记录。");
    }
    seen.add(time);
    addInterval(intervals, time, a, b);
  }
  const covered = Number.isSafeInteger(data.start) && Number.isSafeInteger(data.end) &&
    data.start <= from && data.end >= to && Array.isArray(data.gaps) && !data.gaps.length;
  if (!seen.size && !(covered && data.db === true)) return unavailable("Swolecharts", "窗口内未返回记录，无法确认覆盖。");
  return { source: "Swolecharts", status: covered ? "covered" : "partial", intervals,
    detail: covered ? "币安合约的 5 分钟统计，接口未报告缺口。" : data.gaps?.length
      ? `币安合约的 5 分钟统计，接口报告 ${data.gaps.length} 处缺口。` : "接口未确认窗口覆盖。" };
}

type CoinBossEvent = { exchange: string; symbol: string; timestamp: number | string; side: string;
  value_usd: number | string; price?: string; qty?: string; id?: string | number };

async function coinBossReference(symbol: string, from: number, to: number): Promise<Reference> {
  const limit = 1000, pageStride = 950, maxPages = 8;
  const signal = AbortSignal.timeout(14_000);
  const seen = new Set<string>();
  let covered = false, newest = -Infinity;
  const intervals: Reference["intervals"] = {};
  let previousPage = new Set<string>();
  let joined = true;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL("https://api.coinboss.com/api/liquidations");
    url.search = new URLSearchParams({ symbol, exchange: "binance", limit: String(limit), offset: String(page * pageStride) }).toString();
    const response = await getJson<{ success: boolean; data: CoinBossEvent[] }>(url, signal).catch(() => null);
    if (!response?.success || !Array.isArray(response.data) || !response.data.length) break;
    const keys = new Set<string>();
    let oldest = Infinity;
    for (const row of response.data) {
      const time = Number(row.timestamp), amount = Number(row.value_usd);
      if (row.exchange?.toLowerCase() !== "binance" || row.symbol !== symbol || !Number.isSafeInteger(time) ||
        (row.side !== "LONG" && row.side !== "SHORT") || !Number.isFinite(amount) || amount <= 0) continue;
      oldest = Math.min(oldest, time);
      newest = Math.max(newest, time);
      const key = JSON.stringify(row.id ?? [time, row.side, row.price, row.qty, row.value_usd]);
      keys.add(key);
      if (time < from || time >= to || seen.has(key)) continue;
      seen.add(key);
      addPricedLiquidation(intervals, time, row.side === "LONG" ? "long" : "short", amount, Number(row.price));
    }
    if (page > 0 && ![...keys].some((key) => previousPage.has(key))) joined = false;
    previousPage = keys;
    if (oldest < from) {
      covered = joined && newest >= to;
      break;
    }
    if (response.data.length < limit) break;
  }
  if (!seen.size && !covered) return unavailable("CoinBoss", "未找到可用的窗口内记录，无法确认零爆仓。");
  return { source: "CoinBoss", status: covered ? "covered" : "partial", intervals,
    detail: `币安逐笔档案，窗口内去重后 ${seen.size} 笔。${covered ? "查询记录跨过窗口两端，档案仍可能漏报。" : "分页结果未确认覆盖完整窗口。"}` };
}

const archiveColumns = ["symbol", "side", "trade_time", "average_price", "filled_quantity"];
const hourMs = 3_600_000;

async function readCryptoHFTHour(symbol: string, hour: number, signal: AbortSignal) {
  const utc = new Date(hour).toISOString();
  const file = `binance_futures/${utc.slice(0, 10)}/${utc.slice(11, 13)}/${symbol}_liquidations.parquet`;
  const url = new URL("https://api.cryptohftdata.com/download");
  url.searchParams.set("file", file);
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) return null;
  return parquetReadObjects({ file: await response.arrayBuffer(), compressors, columns: archiveColumns });
}

async function cryptoHFTReference(symbol: string, from: number, to: number): Promise<Reference> {
  const startHour = Math.floor(from / hourMs) * hourMs;
  const hours = Array.from({ length: Math.ceil((to - startHour) / hourMs) }, (_, i) => startHour + i * hourMs);
  const signal = AbortSignal.timeout(25_000);
  const seen = new Set<string>();
  let availableHours = 0;
  const intervals: Reference["intervals"] = {};
  for (let index = 0; index < hours.length && !signal.aborted; index += 6) {
    const batch = await Promise.all(hours.slice(index, index + 6).map((hour) =>
      readCryptoHFTHour(symbol, hour, signal).catch(() => null)));
    for (const rows of batch) {
      if (!rows) continue;
      availableHours++;
      for (const row of rows) {
        const time = Number(row.trade_time), price = Number(row.average_price), quantity = Number(row.filled_quantity);
        if (row.symbol !== symbol || !Number.isSafeInteger(time) || time < from || time >= to ||
          (row.side !== "BUY" && row.side !== "SELL") || !Number.isFinite(price) || price <= 0 ||
          !Number.isFinite(quantity) || quantity <= 0) continue;
        const key = JSON.stringify([time, row.side, price, quantity]);
        if (seen.has(key)) continue;
        seen.add(key);
        addPricedLiquidation(intervals, time, row.side === "SELL" ? "long" : "short", price * quantity, price);
      }
    }
  }
  const detail = `成功读取 ${availableHours} / ${hours.length} 个小时档案，窗口内 ${seen.size} 笔，按成交均价 × 已成交数量统计。`;
  if (!seen.size && availableHours < hours.length) return unavailable("CryptoHFTData", `${detail} 无法确认覆盖。`);
  return { source: "CryptoHFTData", status: availableHours === hours.length ? "covered" : "partial",
    intervals, detail: availableHours === hours.length ? detail : `${detail} 缺失档案可能尚未发布或该小时无记录。` };
}

const cache = new Map<string, { to: number; expires: number; result: ReturnType<typeof loadBacktest> }>();

export function getLiquidationBacktest(instrument: MarketInstrument) {
  const now = Date.now();
  // Leave one closed bar for Binance's open-interest statistics to publish.
  const to = Math.floor(now / LIQUIDATION_INTERVAL_MS) * LIQUIDATION_INTERVAL_MS - LIQUIDATION_INTERVAL_MS;
  const current = cache.get(instrument.id);
  if (current?.to === to && current.expires > now) return current.result;
  const result = loadBacktest(instrument, to - LIQUIDATION_BACKTEST_MS, to).then((data) => {
    if (cache.get(instrument.id)?.result === result) {
      cache.set(instrument.id, { to, expires: Date.now() + 30_000, result });
    }
    return data;
  }).catch((error) => {
    if (cache.get(instrument.id)?.result === result) cache.delete(instrument.id);
    throw error;
  });
  cache.set(instrument.id, { to, expires: Infinity, result });
  return result;
}


export function compareLiquidationBands(reference: Pick<Reference, "status" | "intervals">,
  snapshots: ReadonlyMap<number, LiquidationRiskSnapshot>) {
  if (reference.status === "unavailable") return null;
  return sides.map((side) => {
    const events = Object.entries(reference.intervals).filter(([, observed]) => observed[side] >= LIQUIDATION_EVENT_NOTIONAL)
      .map(([key, observed]) => {
        const time = Number(key);
        const snapshot = snapshots.get(time);
        const fills = observed.fills?.[side] ?? [];
        const prices = fills.reduce<{ low: number; high: number } | null>((range, { price }) => ({
          low: Math.min(range?.low ?? price, price), high: Math.max(range?.high ?? price, price),
        }), null);
        const bands = snapshot?.bands.filter((band) => band.side === side).map((band) => ({ ...band, observedAmount: 0 }));
        for (const fill of fills) {
          const match = bands?.find((band) => fill.price >= band.lowerPrice && fill.price < band.upperPrice);
          if (match) match.observedAmount += fill.amount;
        }
        const inside = bands && fills.length ? bands.reduce((total, band) => total + band.observedAmount, 0) : null;
        const hit = bands?.some((band) => band.observedAmount >= LIQUIDATION_EVENT_NOTIONAL);
        const pricesComplete = fills.length > 0 && !observed.missingPrices?.[side];
        const result = hit ? "hit" as const : !snapshot || !pricesComplete ? "unknown" as const : "miss" as const;
        return { time, asOf: snapshot?.asOf ?? null, amount: observed[side], inside, prices, pricesComplete, bands, result };
      });
    const hits = events.filter((event) => event.result === "hit").length;
    const misses = events.filter((event) => event.result === "miss").length;
    return { side, events: events.length, hits, misses, unknown: events.length - hits - misses,
      hitRate: hits + misses ? hits / (hits + misses) : null, timeline: events };
  });
}

async function loadBacktest(instrument: MarketInstrument, from: number, to: number) {
  const symbol = instrument.id;
  const [result, ...observations] = await Promise.all([
    getBinanceLiquidationReplay(instrument, from, to).then((replay) => ({ replay, marginUnavailable: false }),
      (error: unknown) => ({ replay: null, marginUnavailable: error instanceof BinanceMarginProfileUnavailableError })),
    swoleReference(symbol, from, to).catch(() => unavailable("Swolecharts", "接口暂不可用。")),
    coinBossReference(symbol, from, to).catch(() => unavailable("CoinBoss", "接口暂不可用。")),
    cryptoHFTReference(symbol, from, to).catch(() => unavailable("CryptoHFTData", "逐笔档案暂不可用。")),
  ]);
  const { replay, marginUnavailable } = result;
  const snapshots = new Map(replay?.riskSnapshots.map((snapshot) => [snapshot.time, snapshot]));
  const references = observations.map(({ source, status, detail, intervals }) => ({
    source, status, detail, comparison: compareLiquidationBands({ status, intervals }, snapshots),
  }));
  const modelError = replay ? snapshots.size ? null : "没有可用于核对的历史风险图。"
    : instrument.onboardAt > from ? `该合约上市未满 ${LIQUIDATION_BACKTEST_HOURS} 小时，暂无法回放完整窗口。`
    : marginUnavailable ? BINANCE_MARGIN_UNAVAILABLE_MESSAGE
      : "币安历史仓位或行情数据不完整，暂无法重建风险图。";
  return { symbol, from, to, snapshotCount: snapshots.size, references, modelError, eventNotional: LIQUIDATION_EVENT_NOTIONAL,
    leadMinutes: LIQUIDATION_SNAPSHOT_LEAD_MS / 60_000 };
}

export type LiquidationBacktest = Awaited<ReturnType<typeof loadBacktest>>;
