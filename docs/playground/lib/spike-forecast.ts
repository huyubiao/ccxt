import type { TradeAmounts } from "./market-lookup";
import type { RecentTrade } from "./short-volume";

const MINUTE = 60_000;
const HORIZON_MS = 5 * MINUTE;
export const MAX_FORECAST_AGE_MS = 45_000;
export const FORECAST_VERSION = 1;
export const FORECAST_HISTORY_LIMIT = 100;

export type TradePressure = {
  buyUsdt: number; sellUsdt: number; largeBuyUsdt: number; largeSellUsdt: number; largeThresholdUsdt: number;
};
export type ForecastIndicators = {
  flow: TradePressure | null;
  depth: { bidUsdt: number; askUsdt: number; time: number } | null;
  interest: { change: number; time: number } | null;
  liquidations: { longUsdt: number; shortUsdt: number; time: number } | null;
  holders: { percentage: number; count: number; time: number } | null;
};
export type SpikeForecast = { issuedAt: number; settlesAt: number; price: number; change: number };
export type ForecastAnalysis = { indicators: ForecastIndicators; forecast: SpikeForecast | null };
export type ForecastOutcome = { price: number; time: number };
export type ForecastRecord = {
  symbol: string; time: number; change: number; fallback?: SpikeForecast;
  analysis?: ForecastAnalysis | null; outcome?: ForecastOutcome | null;
};

export function estimateAlertMove(spikeChange: number): number | null {
  if (!Number.isFinite(spikeChange) || spikeChange <= -100 || spikeChange === 0) return null;
  return Math.sign(spikeChange) * Math.min(3, Math.max(0.05, Math.abs(spikeChange) * 0.2));
}

function forecastAt(price: number, issuedAt: number, change: number): SpikeForecast {
  const settlesAt = Math.ceil((issuedAt + HORIZON_MS) / MINUTE) * MINUTE;
  return { issuedAt, settlesAt, price, change };
}

export function forecastAlertMove(spikeChange: number, price: number, time: number): SpikeForecast | undefined {
  const change = estimateAlertMove(spikeChange);
  if (change === null || !Number.isFinite(price) || price <= 0) return undefined;
  return forecastAt(price, time, change);
}

export function getRecordForecast({ analysis, fallback }: ForecastRecord) {
  return analysis?.forecast ?? fallback;
}

export function summarizeTradePressure(trades: RecentTrade[], amounts: TradeAmounts): TradePressure | null {
  const filled = trades.filter(({ amount, side }) => amount > 0 && Number.isFinite(amount) && side !== null);
  if (filled.length < 5) return null;
  const sizes = filled.map(({ amount }) => amount).sort((a, b) => a - b);
  const median = (sizes[Math.floor((sizes.length - 1) / 2)] + sizes[Math.floor(sizes.length / 2)]) / 2;
  const result = { buyUsdt: amounts.buy, sellUsdt: amounts.sell, largeBuyUsdt: 0, largeSellUsdt: 0,
    largeThresholdUsdt: Math.max(10_000, median * 8) };
  for (const { amount, side } of filled) {
    if (amount < result.largeThresholdUsdt) continue;
    if (side === "buy") result.largeBuyUsdt += amount;
    else result.largeSellUsdt += amount;
  }
  return result;
}

function imbalance(buy: number, sell: number) {
  return buy + sell > 0 ? (buy - sell) / (buy + sell) : 0;
}

export function largeTradeSide(flow: TradePressure): "buy" | "sell" | "mixed" | "none" {
  if (flow.largeBuyUsdt + flow.largeSellUsdt === 0) return "none";
  const skew = imbalance(flow.largeBuyUsdt, flow.largeSellUsdt);
  return skew >= 0.2 ? "buy" : skew <= -0.2 ? "sell" : "mixed";
}

export function forecastSpike(indicators: ForecastIndicators, spikeChange: number, price: number, issuedAt: number): SpikeForecast | null {
  const { flow, depth, interest, liquidations, holders } = indicators;
  if (!flow || (!depth && !interest && !liquidations) || !Number.isFinite(price) || price <= 0 ||
      !Number.isFinite(spikeChange) || spikeChange === 0) return null;
  const tradeScore = 0.75 * imbalance(flow.buyUsdt, flow.sellUsdt) +
    0.25 * (flow.largeBuyUsdt - flow.largeSellUsdt) / (flow.buyUsdt + flow.sellUsdt);
  const depthScore = depth ? imbalance(depth.bidUsdt, depth.askUsdt) : 0;
  const liquidationScore = liquidations ? imbalance(liquidations.shortUsdt, liquidations.longUsdt) : 0;
  const score = 0.65 * tradeScore + 0.25 * depthScore + 0.10 * liquidationScore;
  if (!Number.isFinite(score) || Math.abs(score) < 0.15 || Math.sign(score) !== Math.sign(tradeScore)) return null;

  // Open interest and concentration scale the estimated move without assigning a side.
  const interestFactor = 1 + Math.max(-0.2, Math.min(0.2, (interest?.change ?? 0) / 20));
  const concentrationFactor = 1 + Math.min(100, holders?.percentage ?? 0) / 400;
  const change = Math.sign(score) * Math.min(15, Math.max(0.05,
    Math.abs(score) * Math.min(20, Math.abs(spikeChange)) * 0.6 * interestFactor * concentrationFactor));
  return forecastAt(price, issuedAt, change);
}

export function readForecastClose(rows: unknown[][], settlesAt: number): ForecastOutcome | null {
  const row = rows.find((candle) => Number(candle[0]) === settlesAt - MINUTE && Number(candle[6]) === settlesAt - 1);
  const price = Number(row?.[4]);
  return Number.isFinite(price) && price > 0 ? { price, time: settlesAt - 1 } : null;
}

export function compareForecast(forecast: SpikeForecast, outcome: ForecastOutcome) {
  const actual = (outcome.price / forecast.price - 1) * 100;
  return { actual, hit: Math.sign(actual) === Math.sign(forecast.change), error: Math.abs(actual - forecast.change) };
}

export function forecastAccuracy(records: ForecastRecord[]) {
  let samples = 0, hits = 0, totalError = 0;
  for (const record of records) {
    const forecast = getRecordForecast(record);
    if (!forecast || !record.outcome) continue;
    const comparison = compareForecast(forecast, record.outcome);
    samples++;
    hits += Number(comparison.hit);
    totalError += comparison.error;
  }
  return { samples, hits, mae: samples ? totalError / samples : null };
}
