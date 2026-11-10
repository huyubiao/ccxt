import { binanceUsdM } from "./binance-usdm";
import { getOkxFundingData } from "./external-markets";
import { FUNDING_HISTORY_LIMIT, FUNDING_REFRESH_MS, normalizeFundingRates, type MarketFundingRates } from "./funding-rates";
import type { MarketInstrument } from "./market-lookup";

const cache = new Map<string, { expires: number; pending: Promise<MarketFundingRates> }>();

async function getBinanceFundingData(symbol: string, limit: number) {
  const [rows, response] = await Promise.all([
    binanceUsdM.fapiPublicGetFundingRate({ symbol, limit }).catch(() => []),
    binanceUsdM.fapiPublicGetPremiumIndex({ symbol }).catch(() => null),
  ]);
  const quote = response as unknown as { symbol?: string; lastFundingRate?: string; nextFundingTime?: number } | null;
  return {
    history: rows.filter((row) => row.symbol === symbol && row.rateType !== "Special")
      .map((row) => ({ rate: row.fundingRate, time: row.fundingTime })),
    next: quote?.symbol === symbol ? { rate: quote.lastFundingRate, time: quote.nextFundingTime } : null,
  };
}

export function getMarketFundingRates(pair: MarketInstrument): Promise<MarketFundingRates> {
  if (pair.kind !== "futures") return Promise.reject(new Error("Funding rates require a perpetual contract."));
  const { exchange = "binance", id: symbol } = pair;
  const key = `${exchange}:${symbol}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.pending;

  const input = exchange === "okx" ? getOkxFundingData(symbol, FUNDING_HISTORY_LIMIT)
    : getBinanceFundingData(symbol, pair.type === "TRADIFI_PERPETUAL" ? FUNDING_HISTORY_LIMIT * 2 : FUNDING_HISTORY_LIMIT);
  const pending = input.then(({ history, next }) => {
    const data = normalizeFundingRates(exchange, symbol, Date.now(), history, next);
    if (!data.history.length && !data.next) throw new Error("Funding data unavailable.");
    if (cache.get(key)?.pending === pending) cache.set(key, {
      expires: Math.min(Date.now() + FUNDING_REFRESH_MS, data.next?.time ?? Infinity), pending,
    });
    return data;
  }).catch((error) => {
    if (cache.get(key)?.pending === pending) cache.delete(key);
    throw error;
  });
  cache.set(key, { expires: Date.now() + FUNDING_REFRESH_MS, pending });
  return pending;
}
