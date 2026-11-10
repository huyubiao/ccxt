import { binanceUsdM } from "./binance-usdm";
import { getCoinOverview, getDailyMarketCaps } from "./coin-fundamentals";
import {
  estimateLiquidationLevels, LIQUIDATION_INTERVAL_MS, LIQUIDATION_LOOKBACK_MS, LIQUIDATION_REFRESH_MS,
  MARKET_CAP_DAY_MS, MARKET_CAP_WINDOWS, replayLiquidations, selectMarketCapHistory,
  type MarginProfile,
  type LiquidationLevels, type MarketCapHistory, type TurnoverInput,
} from "./liquidation-levels";

type BinanceMarginTable = {
  success?: boolean;
  data?: { brackets?: { symbol: string; riskBrackets?: {
    bracketNotionalFloor: number;
    bracketNotionalCap: number;
    bracketMaintenanceMarginRate: number;
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
          profiles.set(row.symbol, { maxLeverage, maintenanceRate, notionalCap });
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

function canUseCapProxy(instrument: MarketInstrument) {
  // CMC supply is in tokens, whereas the price for a bundled contract is per bundle.
  return instrument.base === instrument.coin && !/^\d{3,}/.test(instrument.base);
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
    if ((cap && cap.windowDays >= 30) || !canUseCapProxy(instrument)) return cap;
    const rows = await binanceUsdM.fapiDataGetOpenInterestHist({ symbol, period: "1d", limit: 30, endTime: referenceTime }).catch(() => []);
    // OI value divided by OI quantity gives the implied per-unit price at each snapshot.
    const proxy: [number, number][] = rows.map((row) => [
      Number(row.timestamp),
      Number(row.sumOpenInterestValue) / Number(row.sumOpenInterest) * Number(row.CMCCirculatingSupply),
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

function interestPoints(rows: InterestRows) {
  return rows.map((row) => ({ time: Number(row.timestamp), quantity: Number(row.sumOpenInterest) }))
    .filter(({ time, quantity }) => Number.isSafeInteger(time) && Number.isFinite(quantity) && quantity >= 0)
    .sort((a, b) => a.time - b.time);
}

function markBarsFrom(rows: MarkRows) {
  return rows.filter(Array.isArray)
    .map(([time, , high, low, close]) => ({ time: Number(time), high: Number(high), low: Number(low), close: Number(close) }))
    .filter(({ time, high, low, close }) => Number.isSafeInteger(time) &&
      [high, low, close].every(Number.isFinite) && low > 0 && low <= close && close <= high);
}

export async function getBinanceLiquidationReplay(instrument: MarketInstrument, from: number, to: number) {
  const { id: symbol } = instrument;
  const step = LIQUIDATION_INTERVAL_MS;
  const historicalStart = Math.max(from - LIQUIDATION_LOOKBACK_MS, Math.ceil(instrument.onboardAt / step) * step);
  if (historicalStart > from) throw new Error("合约上市未满 24 小时，无法回放完整窗口。");
  const oiParams = { symbol, period: "5m", limit: 300 };
  const [before, during, mark, cap, trades, marginProfile] = await Promise.all([
    historicalStart < from ? binanceUsdM.fapiDataGetOpenInterestHist({ ...oiParams, startTime: historicalStart, endTime: from - 1 }) : [],
    binanceUsdM.fapiDataGetOpenInterestHist({ ...oiParams, startTime: from, endTime: to }),
    binanceUsdM.fapiPublicGetMarkPriceKlines({ symbol, interval: "5m", startTime: historicalStart, endTime: to - 1, limit: 600 }),
    getMarketCapHistory(instrument, from),
    canUseCapProxy(instrument) && instrument.type !== "TRADIFI_PERPETUAL"
      ? binanceUsdM.fapiPublicGetKlines({ symbol, interval: "5m", startTime: from - LIQUIDATION_LOOKBACK_MS,
        endTime: from - 1, limit: 288 }).catch(() => []) : [],
    getMarginProfile(symbol),
  ]);
  const bars = markBarsFrom(mark);
  const priorClose = bars.find((bar) => bar.time === from - step)?.close;
  const startSupply = Number([...before, ...during].find((row) => Number(row.timestamp) === from)?.CMCCirculatingSupply);
  const marketCapUsd = startSupply * (priorClose ?? NaN);
  const volumeUsdt = trades.reduce((sum, row) => sum + Number(row[7]), 0);
  const turnover = trades.length === 288 && Number.isFinite(volumeUsdt) && volumeUsdt >= 0 &&
    Number.isFinite(marketCapUsd) && marketCapUsd > 0 ? { volumeUsdt, marketCapUsd, marketCapSource: "binance-cmc-proxy" } : null;
  const result = replayLiquidations(symbol, interestPoints([...before, ...during]), bars, historicalStart, from, to, cap, turnover, marginProfile);
  return { ...result, warmupMinutes: (from - historicalStart) / 60_000 };
}

async function loadLevels(instrument: MarketInstrument) {
  const { id: symbol } = instrument;
  const [interest, bars, response, capitalization, overview, quoteResponse, marginProfile] = await Promise.all([
    binanceUsdM.fapiDataGetOpenInterestHist({ symbol, period: "5m", limit: 289 }),
    binanceUsdM.fapiPublicGetMarkPriceKlines({ symbol, interval: "5m", limit: 290 }),
    binanceUsdM.fapiPublicGetPremiumIndex({ symbol }),
    getMarketCapHistory(instrument),
    getCoinOverview(instrument).catch(() => null),
    binanceUsdM.fapiPublicGetTicker24hr({ symbol }).catch(() => null),
    getMarginProfile(symbol),
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
  const points = interestPoints(interest);
  const markBars = markBarsFrom(bars);
  const market = overview?.market;
  const quote = Array.isArray(quoteResponse) ? null : quoteResponse;
  const quoteVolume = quote?.symbol === symbol && quote.quoteVolume != null ? Number(quote.quoteVolume) : NaN;
  const closeTime = Number(quote?.closeTime);
  let turnover: TurnoverInput | null = null;
  if (Number.isFinite(quoteVolume) && quoteVolume >= 0 && closeTime >= asOf - 300_000 && closeTime <= asOf + 60_000) {
    if (market?.circulatingMarketCap && market.updatedAt && Math.abs(asOf - market.updatedAt) <= MARKET_CAP_DAY_MS) {
      turnover = { volumeUsdt: quoteVolume, marketCapUsd: market.circulatingMarketCap, marketCapSource: market.sourceName };
    } else if (instrument.type !== "TRADIFI_PERPETUAL" && canUseCapProxy(instrument)) {
      const supplyRow = interest.findLast((row) => Number(row.timestamp) <= asOf &&
        Number(row.timestamp) >= asOf - 900_000 && Number(row.CMCCirculatingSupply) > 0);
      const marketCapUsd = Number(supplyRow?.CMCCirculatingSupply) * markPrice;
      if (Number.isFinite(marketCapUsd) && marketCapUsd > 0) {
        turnover = { volumeUsdt: quoteVolume, marketCapUsd, marketCapSource: "binance-cmc-proxy" };
      }
    }
  }
  return estimateLiquidationLevels(symbol, points, markBars, markPrice, asOf, capitalization, turnover, marginProfile);
}
