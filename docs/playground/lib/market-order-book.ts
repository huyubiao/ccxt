import { binanceUsdM } from "./binance-usdm";
import { getOkxOrderBook } from "./external-markets";
import type { MarketInstrument } from "./market-lookup";
import { BOOK_MAX_AGE_MS, BOOK_REFRESH_MS, type BookLevel, type OrderBookSnapshot } from "./order-book";

const cache = new Map<string, { expires: number; result: Promise<OrderBookSnapshot> }>();

function normalizeLevels(rows: unknown, multiplier: number, direction: number): BookLevel[] {
  if (!Array.isArray(rows)) return [];
  const levels = new Map<number, number>();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const price = Number(row[0]), quantity = Number(row[1]) * multiplier;
    if (price > 0 && quantity > 0 && Number.isFinite(price * quantity)) levels.set(price, quantity);
  }
  return [...levels].sort(([a], [b]) => direction * (a - b));
}

async function loadBook(pair: MarketInstrument): Promise<OrderBookSnapshot> {
  const { id: symbol, exchange = "binance", base } = pair;
  const raw = exchange === "okx" ? await getOkxOrderBook(symbol) : await (async () => {
    const result = await binanceUsdM.fapiPublicGetDepth({ symbol, limit: 1000 });
    return { bids: result.bids, asks: result.asks, time: Number(result.E ?? result.T) };
  })();
  const multiplier = exchange === "okx" ? pair.contractSize ?? 0 : 1;
  const bids = normalizeLevels(raw.bids, multiplier, -1), asks = normalizeLevels(raw.asks, multiplier, 1);
  if (!bids.length || !asks.length || bids[0][0] >= asks[0][0] || !Number.isSafeInteger(raw.time) ||
      raw.time < Date.now() - BOOK_MAX_AGE_MS || raw.time > Date.now() + 2_000) {
    throw new Error("Order book unavailable.");
  }
  return { exchange, symbol, base, time: raw.time, bids, asks };
}

export function getMarketOrderBook(pair: MarketInstrument) {
  const key = `${pair.exchange ?? "binance"}:${pair.id}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.result;
  const result = loadBook(pair).catch((error) => {
    if (cache.get(key)?.result === result) cache.delete(key);
    throw error;
  });
  cache.set(key, { expires: Date.now() + BOOK_REFRESH_MS, result });
  return result;
}
