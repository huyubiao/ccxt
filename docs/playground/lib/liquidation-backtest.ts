import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { getBinanceLiquidationReplay } from "./binance-liquidation-levels";
import { LIQUIDATION_INTERVAL_MS, LIQUIDATION_LOOKBACK_MS } from "./liquidation-levels";
import type { MarketInstrument } from "./market-lookup";

type Amounts = { long: number; short: number; total: number };
type Reference = {
  source: "Swolecharts" | "CoinBoss" | "CryptoHFTData";
  status: "covered" | "partial" | "unavailable";
  amounts: Amounts | null;
  detail: string;
};

const totals = (long: number, short: number) => ({ long, short, total: long + short });
const unavailable = (source: Reference["source"], detail: string): Reference => ({
  source, status: "unavailable", amounts: null, detail,
});

async function getJson<T>(url: URL, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Liquidation source returned HTTP ${response.status}`);
  return response.json();
}

async function swoleReference(symbol: string, from: number, to: number): Promise<Reference> {
  const market = `binance:perp:${symbol}`;
  const url = new URL("https://swolecharts.com/api/series/liquidations");
  url.search = new URLSearchParams({ market, start: String(from), end: String(to), step: "1m" }).toString();
  const data = await getJson<{ market: string; start: number; end: number; step: number; t: number[];
    long: number[]; short: number[]; gaps?: unknown[]; db?: boolean; error?: unknown }>(url, AbortSignal.timeout(10_000));
  if (data.market !== market || data.db === false || data.error || data.step !== 60_000 || !Array.isArray(data.t) ||
    !Array.isArray(data.long) || !Array.isArray(data.short) || data.long.length !== data.t.length || data.short.length !== data.t.length) {
    return unavailable("Swolecharts", "未返回可用的币安合约分钟数据。");
  }
  let long = 0, short = 0;
  const seen = new Set<number>();
  for (const [index, time] of data.t.entries()) {
    if (time < from || time >= to) continue;
    const a = data.long[index], b = data.short[index];
    if (!Number.isSafeInteger(time) || time % 60_000 !== 0 || !Number.isFinite(a) || a < 0 || !Number.isFinite(b) || b < 0 || seen.has(time)) {
      return unavailable("Swolecharts", "分钟数据包含无效或重复记录。");
    }
    seen.add(time);
    long += a;
    short += b;
  }
  if (!seen.size) return unavailable("Swolecharts", "窗口内未返回记录，无法确认零爆仓。");
  const covered = data.start <= from && data.end >= to && Array.isArray(data.gaps) && !data.gaps.length;
  return { source: "Swolecharts", status: covered ? "covered" : "partial", amounts: totals(long, short),
    detail: covered ? "币安合约的 1 分钟统计，接口未报告缺口。" : data.gaps?.length
      ? `币安合约的 1 分钟统计，接口报告 ${data.gaps.length} 处缺口。` : "接口未确认窗口覆盖。" };
}

type CoinBossEvent = { exchange: string; symbol: string; timestamp: number | string; side: string;
  value_usd: number | string; price?: string; qty?: string; id?: string | number };

async function coinBossReference(symbol: string, from: number, to: number): Promise<Reference> {
  const limit = 1000, pageStride = 950, maxPages = 8;
  const signal = AbortSignal.timeout(14_000);
  const seen = new Set<string>();
  let long = 0, short = 0, covered = false, newest = -Infinity;
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
      if (row.side === "LONG") long += amount;
      else short += amount;
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
  return { source: "CoinBoss", status: covered ? "covered" : "partial", amounts: totals(long, short),
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
  const signal = AbortSignal.timeout(14_000);
  const seen = new Set<string>();
  let long = 0, short = 0, availableHours = 0;
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
        if (row.side === "SELL") long += price * quantity;
        else short += price * quantity;
      }
    }
  }
  const detail = `成功读取 ${availableHours} / ${hours.length} 个小时档案，窗口内 ${seen.size} 笔，按成交均价 × 已成交数量统计。`;
  if (!seen.size) return unavailable("CryptoHFTData", `${detail} 无法确认零爆仓。`);
  return { source: "CryptoHFTData", status: availableHours === hours.length ? "covered" : "partial",
    amounts: totals(long, short), detail: availableHours === hours.length ? detail : `${detail} 缺失档案可能尚未发布或该小时无记录。` };
}

const cache = new Map<string, { expires: number; result: ReturnType<typeof loadBacktest> }>();

export function getLiquidationBacktest(instrument: MarketInstrument) {
  const now = Date.now();
  const current = cache.get(instrument.id);
  if (current && current.expires > now) return current.result;
  // Leave one closed bar for Binance's open-interest statistics to publish.
  const to = Math.floor(now / LIQUIDATION_INTERVAL_MS) * LIQUIDATION_INTERVAL_MS - LIQUIDATION_INTERVAL_MS;
  const result = loadBacktest(instrument, to - LIQUIDATION_LOOKBACK_MS, to);
  cache.set(instrument.id, { expires: now + 30_000, result });
  return result;
}

async function loadBacktest(instrument: MarketInstrument, from: number, to: number) {
  const symbol = instrument.id;
  const [model, ...observations] = await Promise.all([
    getBinanceLiquidationReplay(instrument, from, to).catch(() => null),
    swoleReference(symbol, from, to).catch(() => unavailable("Swolecharts", "接口暂不可用。")),
    coinBossReference(symbol, from, to).catch(() => unavailable("CoinBoss", "接口暂不可用。")),
    cryptoHFTReference(symbol, from, to).catch(() => unavailable("CryptoHFTData", "逐笔档案暂不可用。")),
  ]);
  const references = observations.map((reference) => {
    const amounts = reference.amounts;
    const delta = model && amounts ? model.total - amounts.total : null;
    return { ...reference, delta, deltaPercent: delta !== null && amounts && amounts.total > 0 ? delta / amounts.total * 100 : null };
  });
  const modelError = model ? null : instrument.onboardAt > from ? "该合约上市未满 24 小时，暂无法回放完整窗口。"
    : "币安历史标记价或持仓数据不足，暂时无法回放模型。";
  return { symbol, from, to, model, references, modelError };
}

export type LiquidationBacktest = Awaited<ReturnType<typeof loadBacktest>>;
