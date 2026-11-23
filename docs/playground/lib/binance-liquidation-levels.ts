import { binanceUsdM, canUseContractSupply, readContractSupplyValuation } from "./binance-usdm";
import { BINANCE_MARGIN_BRACKETS_URL, createBinanceMarginProfileLoader } from "./binance-margin-brackets";
import { getDailyMarketCaps } from "./coin-fundamentals";
import {
  BINANCE_POSITION_CALIBRATION, estimateLiquidationLevels, LIQUIDATION_INTERVAL_MS, LIQUIDATION_LOOKBACK_MS,
  LIQUIDATION_POSITION_HISTORY_MS, LIQUIDATION_REFRESH_MS,
  MARKET_CAP_WINDOWS, LiquidationHistoryIncompleteError, normalizeOpenInterest,
  requireLiquidationHistory, selectMarketCapHistory,
  type LiquidationLevels, type MarketCapHistory,
} from "./liquidation-levels";
import type { MarketInstrument } from "./market-lookup";

const getMarginProfile = createBinanceMarginProfileLoader(() => binanceUsdM.fetch(BINANCE_MARGIN_BRACKETS_URL));
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

function getMarketCapHistory(instrument: MarketInstrument) {
  if (instrument.type === "TRADIFI_PERPETUAL") return Promise.resolve(null);
  const { id: symbol } = instrument;
  const now = Date.now();
  const current = capCache.get(symbol);
  if (current && current.expires > now) return current.result;

  const result = (async () => {
    const [longest, ...fallbacks] = MARKET_CAP_WINDOWS;
    // Fetch one extra boundary day to tolerate the newest daily point's publication delay.
    const historical = await getDailyMarketCaps(instrument, longest + 1).catch(() => null);
    const series = historical?.length ? historical : (await Promise.all(fallbacks.map((days) =>
      getDailyMarketCaps(instrument, days + 1).catch(() => [])))).flat();
    const cap = selectMarketCapHistory(series, "coingecko", now, instrument.onboardAt);
    if ((cap && cap.windowDays >= 30) || !canUseContractSupply(instrument)) return cap;
    const rows = await binanceUsdM.fapiDataGetOpenInterestHist({ symbol, period: "1d", limit: 30, endTime: now }).catch(() => []);
    // OI value divided by OI quantity gives the implied per-unit price at each snapshot.
    const proxy: [number, number][] = rows.map((row) => [
      Number(row.timestamp),
      readContractSupplyValuation(row)?.marketCap ?? NaN,
    ]);
    const fallback = selectMarketCapHistory(proxy, "binance-cmc-proxy", now, instrument.onboardAt);
    return fallback && fallback.samples > (cap?.samples ?? 0) ? fallback : cap;
  })().catch(() => null).then((cap) => {
    if (capCache.get(symbol)?.result === result) {
      capCache.set(symbol, { expires: Date.now() + (cap?.source === "coingecko" ? 360 : 15) * 60_000, result });
    }
    return cap;
  });
  capCache.set(symbol, { expires: now + 60_000, result });
  return result;
}

type InterestRows = Awaited<ReturnType<typeof binanceUsdM.fapiDataGetOpenInterestHist>>;
type MarkRows = Awaited<ReturnType<typeof binanceUsdM.fapiPublicGetMarkPriceKlines>>;
type TradeRows = Awaited<ReturnType<typeof binanceUsdM.fapiPublicGetKlines>>;

// Use half-open ranges so no 5-minute timestamp is skipped or fetched twice at page boundaries.
async function historyPages<Row>(from: number, to: number, pageSize: number,
  fetchPage: (params: { startTime: number; endTime: number; limit: number }) => Promise<Row[]>) {
  const step = LIQUIDATION_INTERVAL_MS;
  const requests: Promise<Row[]>[] = [];
  for (let startTime = from; startTime < to; startTime += pageSize * step) {
    const end = Math.min(to, startTime + pageSize * step);
    requests.push(fetchPage({ startTime, endTime: end - 1, limit: (end - startTime) / step }));
  }
  return (await Promise.all(requests)).flat();
}

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

function markBarsFrom(rows: MarkRows, trades: TradeRows) {
  const volumeByTime = new Map(trades.filter(Array.isArray).map((row) => {
    const volume = row[5] == null || String(row[5]).trim() === "" ? NaN : Number(row[5]);
    const price = Number(row[7]) / volume;
    const turnoverPrice = volume > 0 && Number.isFinite(price) && price > 0 ? price : undefined;
    return [Number(row[0]), { volume, turnoverPrice }];
  }));
  return rows.filter(Array.isArray)
    .map(([time, open, high, low, close]) => ({ time: Number(time), open: Number(open), high: Number(high), low: Number(low), close: Number(close),
      ...volumeByTime.get(Number(time)) }))
    .filter(({ time, open, high, low, close }) => Number.isSafeInteger(time) &&
      [open, high, low, close].every(Number.isFinite) && low > 0 &&
      low <= open && open <= high && low <= close && close <= high);
}

export async function getBinanceClosedMarkBars(symbol: string) {
  const step = LIQUIDATION_INTERVAL_MS;
  const boundary = Math.floor(Date.now() / step) * step;
  const rows = await binanceUsdM.fapiPublicGetMarkPriceKlines({ symbol, interval: "5m", limit: 49, endTime: boundary - 1 });
  return markBarsFrom(rows, []).filter(({ time }) => time % step === 0 && time + step <= boundary);
}

const olderHistoryCache = new Map<string, { start: number; before: number; expires: number; result: ReturnType<typeof loadOlderHistory> }>();

function olderHistory(instrument: MarketInstrument, start: number, before: number) {
  const key = instrument.id;
  const cached = olderHistoryCache.get(key);
  if (cached?.start === start && cached.before === before && cached.expires > Date.now()) return cached.result;
  const result = loadOlderHistory(instrument, start, before).catch((error) => {
    if (olderHistoryCache.get(key)?.result === result) olderHistoryCache.delete(key);
    throw error;
  });
  olderHistoryCache.set(key, { start, before, expires: Date.now() + LIQUIDATION_INTERVAL_MS, result });
  return result;
}

async function loadOlderHistory(instrument: MarketInstrument, from: number, before: number) {
  const step = LIQUIDATION_INTERVAL_MS;
  const listingStart = Math.ceil(instrument.onboardAt / step) * step;
  const start = Math.max(from, listingStart);
  if (start >= before) return { points: [], bars: [] };
  const symbol = instrument.id;
  const markStart = Math.max(listingStart, start - LIQUIDATION_LOOKBACK_MS);
  const [interest, mark, trades] = await Promise.all([
    historyPages(start, before, 500, (page) =>
      binanceUsdM.fapiDataGetOpenInterestHist({ symbol, period: "5m", ...page })),
    historyPages(markStart, before, 1000, (page) =>
      binanceUsdM.fapiPublicGetMarkPriceKlines({ symbol, interval: "5m", ...page })),
    historyPages(start, before, 1000, (page) =>
      binanceUsdM.fapiPublicGetKlines({ symbol, interval: "5m", ...page })),
  ]);
  return { points: normalizeOpenInterest(interest), bars: markBarsFrom(mark, trades) };
}

async function loadLevels(instrument: MarketInstrument) {
  const { id: symbol } = instrument;
  const [interest, bars, response, capitalization, marginProfile, trades] = await Promise.all([
    getRecentInterestRows(symbol),
    binanceUsdM.fapiPublicGetMarkPriceKlines({ symbol, interval: "5m", limit: 578 }),
    binanceUsdM.fapiPublicGetPremiumIndex({ symbol }),
    getMarketCapHistory(instrument),
    getMarginProfile(symbol),
    binanceUsdM.fapiPublicGetKlines({ symbol, interval: "5m", limit: 290 }),
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
  const step = LIQUIDATION_INTERVAL_MS;
  const currentClose = Math.floor(asOf / step) * step;
  // The latest boundary's OI may still be publishing. Require the previous one in that case.
  const to = points.some((point) => point.time === currentClose) ? currentClose : currentClose - step;
  if (!points.some((point) => point.time === to)) throw new LiquidationHistoryIncompleteError();
  const start = to - LIQUIDATION_POSITION_HISTORY_MS;
  const before = points[0].time;
  const older = await olderHistory(instrument, start, before);
  const recentBars = older.bars.length ? markBars.filter((bar) => bar.time >= before) : markBars;
  const allBars = [...older.bars, ...recentBars];
  const window = requireLiquidationHistory([...older.points, ...points], allBars, start, to, instrument.onboardAt, currentClose);
  return estimateLiquidationLevels(symbol, window, allBars,
    markPrice, asOf, capitalization, marginProfile, BINANCE_POSITION_CALIBRATION);
}
