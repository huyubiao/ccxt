import ccxt from "ccxt";
import { getBinanceLiquidationLevels, getBinanceOpenInterestChange } from "./binance-liquidation-levels";
import { binanceUsdM } from "./binance-usdm";
import { getRecentVolumeSeed } from "./binance-volume";
import { getHolderConcentration } from "./coin-holders";
import { positiveNumber } from "./coin-overview";
import { groupLiquidationTable } from "./liquidation-levels";
import type { MarketInstrument } from "./market-lookup";
import { getMarketOrderBook } from "./market-order-book";
import { summarizeDepthNearMid } from "./order-book";
import { sumShortVolume, VOLUME_DELAY_MS } from "./short-volume";
import {
  forecastSpike, MAX_FORECAST_AGE_MS, readForecastClose, summarizeTradePressure, type ForecastAnalysis, type ForecastIndicators,
} from "./spike-forecast";

async function within<T>(request: Promise<T>, milliseconds: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), milliseconds); });
  try {
    return await Promise.race([request.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function getSpikeForecast(pair: MarketInstrument, time: number, change: number): Promise<ForecastAnalysis> {
  const budget = 10_000;
  // Allow the final trades in the alert window to reach the historical endpoint.
  const delay = Math.max(0, time + VOLUME_DELAY_MS - Date.now());
  const tradesAtAlert = new Promise<void>((resolve) => setTimeout(resolve, delay))
    .then(() => getRecentVolumeSeed(pair, time + 1));
  const [trades, book, interest, liquidation, concentration] = await Promise.all([
    within(tradesAtAlert, budget),
    within(getMarketOrderBook(pair), budget),
    within(getBinanceOpenInterestChange(pair.id, time), budget),
    within(getBinanceLiquidationLevels(pair), budget),
    within(getHolderConcentration(pair), budget),
  ]);
  const ticker = await within(binanceUsdM.fapiPublicV2GetTickerPrice({ symbol: pair.id }), 4_000);
  const issuedAt = Date.now();
  const amounts = trades && sumShortVolume(trades.trades, trades.asOf, null, false, trades.coveredFrom)
    .find(({ period }) => period === "1m")?.amounts;
  const flow = trades && amounts ? summarizeTradePressure(trades.trades, amounts) : null;
  let liquidations: ForecastIndicators["liquidations"] = null;
  if (liquidation && liquidation.asOf <= issuedAt && issuedAt - liquidation.asOf <= 120_000) {
    const { levels, markPrice, asOf } = liquidation;
    const [long] = groupLiquidationTable(levels, markPrice, "long", [0, 2]);
    const [short] = groupLiquidationTable(levels, markPrice, "short", [0, 2]);
    liquidations = { longUsdt: long.estimatedLiquidationUsdt, shortUsdt: short.estimatedLiquidationUsdt, time: asOf };
  }
  const holderPercentage = concentration?.totalMarketCapPercentage;
  const indicators: ForecastIndicators = {
    flow,
    depth: book && book.time <= issuedAt && issuedAt - book.time <= 20_000 ? summarizeDepthNearMid(book, 0.005) : null,
    interest,
    liquidations,
    holders: concentration && !concentration.stale && concentration.rows.length && concentration.fetchedAt <= issuedAt &&
      typeof holderPercentage === "number" && holderPercentage >= 0 && holderPercentage <= 100
      ? { percentage: holderPercentage, count: concentration.rows.length, time: concentration.fetchedAt } : null,
  };
  const price = ticker && !Array.isArray(ticker) && ticker.symbol === pair.id ? positiveNumber(ticker.price) : null;
  const priceTime = ticker && !Array.isArray(ticker) ? Number(ticker.time) : NaN;
  const freshPrice = Number.isSafeInteger(priceTime) && priceTime >= time && priceTime <= issuedAt && issuedAt - priceTime <= 15_000;
  const forecast = price !== null && freshPrice && issuedAt - time <= MAX_FORECAST_AGE_MS
    ? forecastSpike(indicators, change, price, issuedAt) : null;
  return { indicators, forecast };
}

export async function getSpikeForecastOutcome(symbol: string, settlesAt: number) {
  try {
    const rows = await binanceUsdM.fapiPublicGetKlines({
      symbol, interval: "1m", startTime: settlesAt - 60_000, endTime: settlesAt - 1, limit: 1,
    });
    return readForecastClose(rows, settlesAt);
  } catch (error) {
    if (error instanceof ccxt.BadSymbol) return null;
    throw error;
  }
}
