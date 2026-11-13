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

function bookNotional(levels: BookLevel[]) {
  return levels.reduce((sum, [price, quantity]) => sum + price * quantity, 0);
}

export function summarizeDepthGroup(levels: BookLevel[], start: number) {
  const group = levels.slice(start, start + 100);
  if (!group.length) return null;
  return {
    firstPrice: group[0][0],
    lastPrice: group[group.length - 1][0],
    amount: bookNotional(group),
  };
}

export function summarizeDepthNearMid(book: OrderBookSnapshot, distance: number) {
  const [bid] = book.bids, [ask] = book.asks;
  if (!bid || !ask || bid[0] >= ask[0]) return null;
  const mid = (bid[0] + ask[0]) / 2;
  const lower = mid * (1 - distance), upper = mid * (1 + distance);
  if (bid[0] < lower || ask[0] > upper) return null;
  return { bidUsdt: bookNotional(book.bids.filter(([price]) => price >= lower)),
    askUsdt: bookNotional(book.asks.filter(([price]) => price <= upper)), time: book.time };
}
