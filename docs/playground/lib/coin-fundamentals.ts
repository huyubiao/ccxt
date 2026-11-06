import { binanceSpot } from "./binance-markets";
import { positiveNumber, type CoinOverview, type CoinUnlock, type CoinValuation } from "./coin-overview";
import type { MarketInstrument } from "./market-lookup";
import { getNextUnlock } from "./coin-unlocks";

type MarketIdentity = { symbol: string; target: string; coin_id: string; contract_type: string };
type CoinGeckoMarket = {
  id: string; symbol: string; current_price: number | null;
  market_cap: number | null; total_supply: number | null; last_updated: string | null;
  source?: "CoinMarketCap";
};
type CmcMarket = {
  data?: {
    slug: string; symbol: string; lastUpdated?: string;
    statistics?: { price?: number; marketCap?: number; totalSupply?: number; lastUpdated?: string };
  };
};

const MINUTE = 60_000;
const marketCache = new Map<string, { expiresAt: number; pending: Promise<CoinGeckoMarket | null> }>();
let identities: { expiresAt: number; pending: Promise<Map<string, string>> } | undefined;

function gecko<T>(path: string): Promise<T> {
  const key = process.env.COINGECKO_DEMO_API_KEY;
  const headers = key ? { "x-cg-demo-api-key": key } : undefined;
  return binanceSpot.fetch(`https://api.coingecko.com/api/v3/${path}`, "GET", headers);
}

function getIdentities() {
  if (identities && Date.now() < identities.expiresAt) return identities.pending;
  const pending = gecko<{ tickers: MarketIdentity[] }>("derivatives/exchanges/binance_futures?include_tickers=all")
    .then(({ tickers }) => {
      if (!Array.isArray(tickers)) throw new Error("CoinGecko futures directory unavailable.");
      const result = new Map<string, string>();
      for (const { symbol, target, coin_id, contract_type } of tickers) {
        if (target === "USDT" && coin_id && contract_type === "perpetual") result.set(symbol, coin_id);
      }
      return result;
    }).catch((error) => {
      if (identities?.pending === pending) identities = undefined;
      throw error;
    });
  identities = { expiresAt: Date.now() + 30 * MINUTE, pending };
  return pending;
}

async function getCmcMarket(id: string, symbol: string): Promise<CoinGeckoMarket | null> {
  const { data } = await binanceSpot.fetch(
    `https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail?slug=${encodeURIComponent(id)}`,
  ) as CmcMarket;
  if (data?.slug !== id || data.symbol?.toUpperCase() !== symbol || !data.statistics) return null;
  const stats = data.statistics;
  return {
    id, symbol: data.symbol, current_price: stats.price ?? null, market_cap: stats.marketCap ?? null,
    total_supply: stats.totalSupply ?? null, last_updated: stats.lastUpdated ?? data.lastUpdated ?? null,
    source: "CoinMarketCap",
  };
}

function getMarket(id: string, symbol: string) {
  const cached = marketCache.get(id);
  if (cached && Date.now() < cached.expiresAt) return cached.pending;
  const pending = gecko<CoinGeckoMarket[]>(`coins/markets?vs_currency=usd&ids=${encodeURIComponent(id)}`)
    .then((rows) => {
      if (!Array.isArray(rows)) throw new Error("CoinGecko market data unavailable.");
      return rows.find((row) => row.id === id) ?? null;
    }).catch(async (error) => {
      const alternative = await getCmcMarket(id, symbol);
      if (alternative) return alternative;
      throw error;
    }).catch((error) => {
      if (marketCache.get(id)?.pending === pending) marketCache.delete(id);
      throw error;
    });
  marketCache.set(id, { expiresAt: Date.now() + MINUTE, pending });
  return pending;
}

export async function getCoinOverview(instrument: MarketInstrument): Promise<CoinOverview> {
  const empty = { market: null, unlock: null };
  if (instrument.type === "TRADIFI_PERPETUAL") return { ...empty, status: "not-applicable" };
  const id = (await getIdentities()).get(instrument.id);
  if (!id) return { ...empty, status: "unmapped" };

  const marketRequest = getMarket(id, instrument.coin);
  const unlockRequest = marketRequest.catch(() => null)
    .then((row) => getNextUnlock(id, row?.symbol ?? instrument.coin));
  const [marketResult, unlockResult] = await Promise.allSettled([marketRequest, unlockRequest]);
  const row = marketResult.status === "fulfilled" ? marketResult.value : null;
  const price = positiveNumber(row?.current_price);
  const supply = positiveNumber(row?.total_supply);
  const market: CoinValuation | null = row ? {
    price,
    circulatingMarketCap: positiveNumber(row.market_cap),
    totalMarketCap: price !== null && supply !== null ? price * supply : null,
    updatedAt: row.last_updated ? positiveNumber(Date.parse(row.last_updated)) : null,
    sourceUrl: row.source === "CoinMarketCap" ? `https://coinmarketcap.com/currencies/${encodeURIComponent(id)}/`
      : `https://www.coingecko.com/en/coins/${encodeURIComponent(id)}`,
    sourceName: row.source ?? "CoinGecko",
  } : null;
  const unlock: CoinUnlock | null = unlockResult.status === "fulfilled" ? unlockResult.value : null;
  return { market, unlock, status: "ready", marketError: marketResult.status === "rejected", unlockError: unlockResult.status === "rejected" };
}
