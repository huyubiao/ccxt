import type { MarketExchange } from "./market-lookup";

export type BookLevel = [price: number, quantity: number];
export type OrderBookSnapshot = {
  exchange: MarketExchange;
  symbol: string;
  base: string;
  time: number;
  bids: BookLevel[];
  asks: BookLevel[];
};

export const BOOK_REFRESH_MS = 5_000;
export const BOOK_MAX_AGE_MS = 15_000;

export function summarizeDepthGroup(levels: BookLevel[], start: number) {
  const group = levels.slice(start, start + 100);
  if (!group.length) return null;
  return {
    firstPrice: group[0][0],
    lastPrice: group[group.length - 1][0],
    amount: group.reduce((sum, [price, quantity]) => sum + price * quantity, 0),
  };
}
