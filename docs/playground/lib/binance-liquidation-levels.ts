import { binanceUsdM, canUseContractSupply, readContractSupplyValuation } from "./binance-usdm";
import { getCirculatingMarketCap, getDailyMarketCaps } from "./coin-fundamentals";
import {
  estimateLiquidationLevels, LIQUIDATION_INTERVAL_MS, LIQUIDATION_LOOKBACK_MS, LIQUIDATION_POSITION_HISTORY_MS, LIQUIDATION_REFRESH_MS,
  MARKET_CAP_DAY_MS, MARKET_CAP_WINDOWS, latestOpenInterestChange, normalizeOpenInterest, replayLiquidations, selectMarketCapHistory,
  type MarginProfile,
  type LiquidationLevels, type MarketCapHistory, type TurnoverInput,
} from "./liquidation-levels";

type BinanceMarginTable = {
  success?: boolean;
  data?: { brackets?: { symbol: string; riskBrackets?: {
    bracketNotionalFloor: number;
    bracketNotionalCap: number;
    bracketMaintenanceMarginRate: number;
    cumFastMaintenanceAmount: number;
    maxOpenPosLeverage: number;
  }[] }[] };
};

let marginSnapshot: { profiles: Map<string, MarginProfile>; expires: number } | undefined;
let marginPending: Promise<Map<string, MarginProfile>> | undefined;

async function getMarginProfile(symbol: string) {
  if (!marginSnapshot || marginSnapshot.expires <= Date.now()) {
    marginPending ??= (async () => {
      const response = await fetch("https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets", {
        cache: "no-store", signal: AbortSignal.timeout(6_000),
      });
      if (!response.ok) throw new Error("Binance margin table unavailable.");
      const body: BinanceMarginTable = await response.json();
      if (!body.success || !Array.isArray(body.data?.brackets)) throw new Error("Invalid Binance margin table.");
      const profiles = new Map<string, MarginProfile>();
      for (const row of body.data.brackets) {
        const first = row.riskBrackets?.find((bracket) => bracket.bracketNotionalFloor === 0);
        if (!first) continue;
        const { maxOpenPosLeverage: maxLeverage, bracketMaintenanceMarginRate: maintenanceRate,
          bracketNotionalCap: notionalCap } = first;
        if (Number.isSafeInteger(maxLeverage) && maxLeverage >= 1 && Number.isFinite(notionalCap) && notionalCap > 0 &&
          Number.isFinite(maintenanceRate) && maintenanceRate >= 0 && maintenanceRate < 1 / maxLeverage) {
          const brackets = (row.riskBrackets ?? []).map((bracket) => ({
            floor: bracket.bracketNotionalFloor, cap: bracket.bracketNotionalCap, rate: bracket.bracketMaintenanceMarginRate,
            deduction: bracket.cumFastMaintenanceAmount, maxLeverage: bracket.maxOpenPosLeverage,
          })).sort((a, b) => a.floor - b.floor);
          const complete = brackets.every((bracket, index) => Object.values(bracket).every(Number.isFinite) &&
            bracket.floor === (brackets[index - 1]?.cap ?? 0) && bracket.cap > bracket.floor &&
            bracket.rate >= 0 && bracket.rate < 1 && bracket.deduction >= 0 && bracket.maxLeverage >= 1);
          profiles.set(row.symbol, { maxLeverage, maintenanceRate, notionalCap, brackets: complete ? brackets : undefined });
        }
      }
      if (!profiles.size) throw new Error("Binance margin table is empty.");
      marginSnapshot = { profiles, expires: Date.now() + 60 * 60_000 };
      return profiles;
    })().catch(() => {
      const profiles = marginSnapshot?.profiles ?? new Map<string, MarginProfile>();
      marginSnapshot = { profiles, expires: Date.now() + 60_000 };
      return profiles;
    }).finally(() => { marginPending = undefined; });
    return (await marginPending).get(symbol) ?? null;
  }
  return marginSnapshot.profiles.get(symbol) ?? null;
}
import type { MarketInstrument } from "./market-lookup";

const cache = new Map<string, { expires: number; result: Promise<LiquidationLevels> }>();
const capCache = new Map<string, { expires: number; result: Promise<MarketCapHistory | null> }>();

export function getBinanceLiquidationLevels(instrument: MarketInstrument): Promise<LiquidationLevels> {
  const { id: symbol } = instrument;
  const current = cache.get(symbol);
  if (current && current.expires > Date.now()) return current.result;

  const result = loadLevels(instrument).catch((error) => {
    if (cache.get(symbol)?.result === result) cache.delete(symbol);
    throw error;
  });
  cache.set(symbol, { expires: Date.now() + LIQUIDATION_REFRESH_MS, result });
  return result;
}

function getMarketCapHistory(instrument: MarketInstrument, asOf?: number) {
  if (instrument.type === "TRADIFI_PERPETUAL") return Promise.resolve(null);
  const { id: symbol } = instrument;
  const now = Date.now();
  const referenceTime = asOf ?? now;
  const key = asOf === undefined ? symbol : `${symbol}:${Math.floor(asOf / MARKET_CAP_DAY_MS)}`;
  const current = capCache.get(key);
  if (current && current.expires > now) return current.result;

  const result = (async () => {
    const [longest, ...fallbacks] = MARKET_CAP_WINDOWS;
    // Fetch one extra boundary day to tolerate the newest daily point's publication delay.
    const extraDays = Math.floor(now / MARKET_CAP_DAY_MS) - Math.floor(referenceTime / MARKET_CAP_DAY_MS) + 1;
    const historical = await getDailyMarketCaps(instrument, longest + extraDays).catch(() => null);
    const series = historical?.length ? historical : (await Promise.all(fallbacks.map((days) =>
      getDailyMarketCaps(instrument, days + extraDays).catch(() => [])))).flat();
    const cap = selectMarketCapHistory(series, "coingecko", referenceTime, instrument.onboardAt);
    if ((cap && cap.windowDays >= 30) || !canUseContractSupply(instrument)) return cap;
    const rows = await binanceUsdM.fapiDataGetOpenInterestHist({ symbol, period: "1d", limit: 30, endTime: referenceTime }).catch(() => []);
    // OI value divided by OI quantity gives the implied per-unit price at each snapshot.
    const proxy: [number, number][] = rows.map((row) => [
      Number(row.timestamp),
      readContractSupplyValuation(row)?.marketCap ?? NaN,
    ]);
    const fallback = selectMarketCapHistory(proxy, "binance-cmc-proxy", referenceTime, instrument.onboardAt);
    return fallback && fallback.samples > (cap?.samples ?? 0) ? fallback : cap;
  })().catch(() => null).then((cap) => {
    if (capCache.get(key)?.result === result) {
      capCache.set(key, { expires: Date.now() + (cap?.source === "coingecko" ? 360 : 15) * 60_000, result });
    }
    return cap;
  });
  capCache.set(key, { expires: now + 60_000, result });
  return result;
}

type InterestRows = Awaited<ReturnType<typeof binanceUsdM.fapiDataGetOpenInterestHist>>;
type MarkRows = Awaited<ReturnType<typeof binanceUsdM.fapiPublicGetMarkPriceKlines>>;
type TradeRows = Awaited<ReturnType<typeof binanceUsdM.fapiPublicGetKlines>>;

const recentInterest = new Map<string, { expires: number; result: Promise<InterestRows> }>();

function getRecentInterestRows(symbol: string): Promise<InterestRows> {
  const cached = recentInterest.get(symbol);
  if (cached && cached.expires > Date.now()) return cached.result;
  const result = binanceUsdM.fapiDataGetOpenInterestHist({ symbol, period: "5m", limit: 289 }).catch((error) => {
    if (recentInterest.get(symbol)?.result === result) recentInterest.delete(symbol);
    throw error;
  });
  recentInterest.set(symbol, { expires: Date.now() + 15_000, result });
  return result;
}

export async function getBinanceOpenInterestChange(symbol: string, asOf: number) {
  return latestOpenInterestChange(normalizeOpenInterest(await getRecentInterestRows(symbol)), asOf);
}

function markBarsFrom(rows: MarkRows, trades: TradeRows) {
  const volumeByTime = new Map(trades.filter(Array.isArray).map((row) => [Number(row[0]), Number(row[5])]));
  return rows.filter(Array.isArray)
    .map(([time, , high, low, close]) => ({ time: Number(time), high: Number(high), low: Number(low), close: Number(close),
      volume: volumeByTime.get(Number(time)) }))
    .filter(({ time, high, low, close }) => Number.isSafeInteger(time) &&
      [high, low, close].every(Number.isFinite) && low > 0 && low <= close && close <= high);
}

const olderHistoryCache = new Map<string, { before: number; expires: number; result: ReturnType<typeof loadOlderHistory> }>();

function olderHistory(instrument: MarketInstrument, before: number) {
  const key = instrument.id;
  const cached = olderHistoryCache.get(key);
  if (cached?.before === before && cached.expires > Date.now()) return cached.result;
  const result = loadOlderHistory(instrument, before);
  olderHistoryCache.set(key, { before, expires: Date.now() + LIQUIDATION_INTERVAL_MS, result });
  return result;
}

async function loadOlderHistory(instrument: MarketInstrument, before: number) {
  const step = LIQUIDATION_INTERVAL_MS;
  const start = Math.max(before - (LIQUIDATION_POSITION_HISTORY_MS - LIQUIDATION_LOOKBACK_MS),
    Math.ceil(instrument.onboardAt / step) * step);
  if (start >= before) return { points: [], bars: [] };
  const requests: Promise<InterestRows>[] = [];
  for (let time = start; time < before; time += LIQUIDATION_LOOKBACK_MS) {
    requests.push(binanceUsdM.fapiDataGetOpenInterestHist({ symbol: instrument.id, period: "5m", limit: 288,
      startTime: time, endTime: Math.min(before, time + LIQUIDATION_LOOKBACK_MS) - 1 }).catch(() => []));
  }
  const [interest, mark, trades] = await Promise.all([Promise.all(requests),
    binanceUsdM.fapiPublicGetMarkPriceKlines({ symbol: instrument.id, interval: "5m", limit: 600,
      startTime: start - step, endTime: before - 1 }).catch(() => []),
    binanceUsdM.fapiPublicGetKlines({ symbol: instrument.id, interval: "5m", limit: 600,
      startTime: start, endTime: before - 1 }).catch(() => []),
  ]);
  const pointsByTime = new Map(normalizeOpenInterest(interest.flat()).map((point) => [point.time, point]));
  const barsByTime = new Map(markBarsFrom(mark, trades).map((bar) => [bar.time, bar]));
  const points = [], bars = [];
  // Only extend the replay through consecutive intervals ending at the known boundary.
  for (let time = before - step; time >= start; time -= step) {
    const point = pointsByTime.get(time), bar = barsByTime.get(time);
    if (!point || !bar) break;
    points.push(point);
    bars.push(bar);
  }
  const priorBar = barsByTime.get((points.at(-1)?.time ?? before) - step);
  if (points.length && priorBar) bars.push(priorBar);
  return { points: points.reverse(), bars: bars.reverse() };
}

export async function getBinanceLiquidationReplay(instrument: MarketInstrument, from: number, to: number) {
  const { id: symbol } = instrument;
  const step = LIQUIDATION_INTERVAL_MS;
  const historicalStart = Math.max(from - LIQUIDATION_LOOKBACK_MS, Math.ceil(instrument.onboardAt / step) * step);
  if (historicalStart > from) throw new Error("合约上市未满 24 小时，无法回放完整窗口。");
  const oiParams = { symbol, period: "5m", limit: 300 };
  const [before, during, mark, cap, trades, marginProfile, older] = await Promise.all([
    historicalStart < from ? binanceUsdM.fapiDataGetOpenInterestHist({ ...oiParams, startTime: historicalStart, endTime: from - 1 }) : [],
    binanceUsdM.fapiDataGetOpenInterestHist({ ...oiParams, startTime: from, endTime: to }),
    binanceUsdM.fapiPublicGetMarkPriceKlines({ symbol, interval: "5m", startTime: historicalStart - step, endTime: to - 1, limit: 600 }),
    getMarketCapHistory(instrument, from),
    binanceUsdM.fapiPublicGetKlines({ symbol, interval: "5m", startTime: from - LIQUIDATION_LOOKBACK_MS,
      endTime: to - 1, limit: 600 }).catch(() => []),
    getMarginProfile(symbol),
    olderHistory(instrument, historicalStart),
  ]);
  const bars = markBarsFrom(mark, trades);
  const priorClose = bars.find((bar) => bar.time === from - step)?.close;
  const startSupply = Number([...before, ...during].find((row) => Number(row.timestamp) === from)?.CMCCirculatingSupply);
  const marketCapUsd = startSupply * (priorClose ?? NaN);
  const beforeTrades = trades.filter((row) => Number(row[0]) < from);
  const volumeUsdt = beforeTrades.reduce((sum, row) => sum + Number(row[7]), 0);
  const turnover = canUseContractSupply(instrument) &&
    beforeTrades.length === LIQUIDATION_LOOKBACK_MS / step && Number.isFinite(volumeUsdt) && volumeUsdt >= 0 &&
    Number.isFinite(marketCapUsd) && marketCapUsd > 0 ? { volumeUsdt, marketCapUsd, marketCapSource: "binance-cmc-proxy" } : null;
  const recentPoints = normalizeOpenInterest([...before, ...during]);
  const warmup = older.points[0]?.time ?? historicalStart;
  const replayBars = older.points.length ? bars.filter((bar) => bar.time >= historicalStart) : bars;
  const result = replayLiquidations(symbol, [...older.points, ...recentPoints],
    [...older.bars, ...replayBars], warmup, from, to, cap, turnover, marginProfile);
  const shorterReplay = warmup < historicalStart
    ? replayLiquidations(symbol, recentPoints, bars, historicalStart, from, to, cap, turnover, marginProfile) : null;
  const warmupComparison = shorterReplay && {
    minutes: (from - historicalStart) / 60_000,
    long: shorterReplay.long, short: shorterReplay.short,
  };
  return { ...result, warmupMinutes: (from - warmup) / 60_000, warmupComparison };
}

async function loadLevels(instrument: MarketInstrument) {
  const { id: symbol } = instrument;
  const [interest, bars, response, capitalization, market, quoteResponse, marginProfile, trades] = await Promise.all([
    getRecentInterestRows(symbol),
    binanceUsdM.fapiPublicGetMarkPriceKlines({ symbol, interval: "5m", limit: 290 }),
    binanceUsdM.fapiPublicGetPremiumIndex({ symbol }),
    getMarketCapHistory(instrument),
    getCirculatingMarketCap(instrument).catch(() => null),
    binanceUsdM.fapiPublicGetTicker24hr({ symbol }).catch(() => null),
    getMarginProfile(symbol),
    binanceUsdM.fapiPublicGetKlines({ symbol, interval: "5m", limit: 290 }).catch(() => []),
  ]);
  // The single-symbol request returns an object. The generated CCXT signature uses the array form.
  const ticker = response as unknown as { symbol?: string; markPrice?: string; time?: number };
  const markPrice = Number(ticker?.markPrice);
  const asOf = Number(ticker?.time);
  if (!Array.isArray(interest) || !Array.isArray(bars) || ticker?.symbol !== symbol ||
    !Number.isFinite(markPrice) || markPrice <= 0 || !Number.isSafeInteger(asOf) ||
    asOf < Date.now() - 120_000 || asOf > Date.now() + 10_000) {
    throw new Error("Binance liquidation model inputs are unavailable.");
  }
  const points = normalizeOpenInterest(interest);
  const markBars = markBarsFrom(bars, trades);
  const older = points.length ? await olderHistory(instrument, points[0].time) : { points: [], bars: [] };
  const quote = Array.isArray(quoteResponse) ? null : quoteResponse;
  const quoteVolume = quote?.symbol === symbol && quote.quoteVolume != null ? Number(quote.quoteVolume) : NaN;
  const closeTime = Number(quote?.closeTime);
  let turnover: TurnoverInput | null = null;
  if (Number.isFinite(quoteVolume) && quoteVolume >= 0 && closeTime >= asOf - 300_000 && closeTime <= asOf + 60_000) {
    if (market?.circulatingMarketCap && market.updatedAt && Math.abs(asOf - market.updatedAt) <= MARKET_CAP_DAY_MS) {
      turnover = { volumeUsdt: quoteVolume, marketCapUsd: market.circulatingMarketCap, marketCapSource: market.sourceName };
    } else if (canUseContractSupply(instrument)) {
      const supplyRow = interest.findLast((row) => Number(row.timestamp) <= asOf &&
        Number(row.timestamp) >= asOf - 900_000 && Number(row.CMCCirculatingSupply) > 0);
      const marketCapUsd = Number(supplyRow?.CMCCirculatingSupply) * markPrice;
      if (Number.isFinite(marketCapUsd) && marketCapUsd > 0) {
        turnover = { volumeUsdt: quoteVolume, marketCapUsd, marketCapSource: "binance-cmc-proxy" };
      }
    }
  }
  const recentBars = older.points.length ? markBars.filter((bar) => bar.time >= points[0].time) : markBars;
  return estimateLiquidationLevels(symbol, [...older.points, ...points], [...older.bars, ...recentBars],
    markPrice, asOf, capitalization, turnover, marginProfile);
}
