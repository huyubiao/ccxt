import type { MarketExchange } from "./market-lookup";

export const FUNDING_HISTORY_LIMIT = 12;
export const FUNDING_REFRESH_MS = 30_000;

export type FundingRatePoint = { rate: number; time: number };
export type MarketFundingRates = {
  exchange: MarketExchange;
  symbol: string;
  updatedAt: number;
  previous: FundingRatePoint | null;
  next: FundingRatePoint | null;
  history: FundingRatePoint[];
};

type RawPoint = { rate: unknown; time: unknown };

function numeric(value: unknown) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return NaN;
  return Number(value);
}

function parsePoint(point: RawPoint | null): FundingRatePoint | null {
  if (!point) return null;
  const rate = numeric(point.rate), time = numeric(point.time);
  return Number.isFinite(rate) && Number.isSafeInteger(time) && time > 0 ? { rate, time } : null;
}

export function normalizeFundingRates(exchange: MarketExchange, symbol: string, updatedAt: number,
  rows: RawPoint[], upcoming: RawPoint | null): MarketFundingRates {
  const settled = new Map<number, FundingRatePoint>();
  for (const row of rows) {
    const point = parsePoint(row);
    if (point && point.time <= updatedAt) settled.set(point.time, point);
  }
  const history = [...settled.values()].sort((a, b) => b.time - a.time).slice(0, FUNDING_HISTORY_LIMIT);
  const next = parsePoint(upcoming);
  return { exchange, symbol, updatedAt, history, previous: history[0] ?? null,
    next: next && next.time > updatedAt ? next : null };
}
