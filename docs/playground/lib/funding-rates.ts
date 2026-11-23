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
