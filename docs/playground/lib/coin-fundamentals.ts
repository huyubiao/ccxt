import { binanceSpot } from "./binance-markets";
import { positiveNumber, type CoinOverview, type CoinValuation } from "./coin-overview";
import type { MarketInstrument } from "./market-lookup";
import { getStoredIdentity, readUnlockSnapshot, type StoredToken } from "./coin-unlocks";
import { fetchUnlockSnapshot } from "../scripts/fetch-unlock-snapshot.mjs";
import sourceAliases from "./coin-source-aliases.json";

type MarketIdentity = { symbol: string; target: string; coin_id: string; contract_type: string };
type CoinGeckoMarket = {
  id: string; symbol: string; current_price: number | null;
  market_cap: number | null; total_supply: number | null; last_updated: string | null;
  max_supply?: number | null;
  unlimited?: boolean;
  source?: "CoinMarketCap";
};
type CmcMarket = {
  data?: {
    id: number; slug: string; symbol: string; lastUpdated?: string; isInfiniteMaxSupply?: number;
    platforms?: { contractId: number; contractChainId: number; contractAddress: string; contractPlatform: string }[];
    statistics?: { price?: number; marketCap?: number; circulatingSupply?: number; totalSupply?: number; maxSupply?: number; lastUpdated?: string };
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

export async function getResearchIdentity(instrument: MarketInstrument) {
  return getStoredIdentity(instrument.id) ?? (await getIdentities()).get(instrument.id);
}

export async function getDailyMarketCaps(instrument: MarketInstrument, days: number): Promise<[number, number][]> {
  const id = await getResearchIdentity(instrument);
  if (!id) return [];
  const { market_caps } = await gecko<{ market_caps?: [number, number][] }>(
    `coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}&interval=daily`,
  );
  return Array.isArray(market_caps) ? market_caps : [];
}

export async function getCmcDetail(id: string, symbol: string) {
  const slug = (sourceAliases as Record<string, string>)[id] ?? id;
  const { data } = await binanceSpot.fetch(
    `https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail?slug=${encodeURIComponent(slug)}`,
  ) as CmcMarket;
  if (data?.slug !== slug || data.symbol?.toUpperCase() !== symbol || !data.statistics) return null;
  return data;
}

export async function getGeckoTokenPlatforms(id: string, symbol: string) {
  const detail = await gecko<{ id: string; symbol: string; asset_platform_id?: string; platforms?: Record<string, string> }>(
    `coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
  );
  return detail?.id === id && detail.symbol?.toUpperCase() === symbol ? detail : null;
}

async function getCmcMarket(id: string, symbol: string): Promise<CoinGeckoMarket | null> {
  const data = await getCmcDetail(id, symbol);
  if (!data?.statistics) return null;
  const stats = data.statistics;
  return {
    id, symbol: data.symbol, current_price: stats.price ?? null, market_cap: stats.marketCap ?? null,
    total_supply: stats.totalSupply ?? null, last_updated: stats.lastUpdated ?? data.lastUpdated ?? null,
    max_supply: stats.maxSupply ?? null, unlimited: data.isInfiniteMaxSupply === 1,
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

function marketCapitalization(row: CoinGeckoMarket) {
  return {
    circulatingMarketCap: positiveNumber(row.market_cap),
    updatedAt: row.last_updated ? positiveNumber(Date.parse(row.last_updated)) : null,
    sourceName: row.source ?? "CoinGecko",
  };
}

export async function getCirculatingMarketCap(instrument: MarketInstrument) {
  if (instrument.type === "TRADIFI_PERPETUAL") return null;
  const id = await getResearchIdentity(instrument);
  const row = id ? await getMarket(id, instrument.coin) : null;
  return row ? marketCapitalization(row) : null;
}

export async function getCoinOverview(instrument: MarketInstrument): Promise<CoinOverview> {
  if (instrument.type === "TRADIFI_PERPETUAL") return { market: null, unlock: null, tokenomics: null, status: "not-applicable" };
  const storedId = getStoredIdentity(instrument.id);
  const seededMarket = storedId ? getMarket(storedId, instrument.coin).catch(() => undefined) : null;
  let lookup: Promise<Map<string, string> | null> | undefined;
  const getDirectory = () => lookup ??= getIdentities().catch(() => null);
  const { tokenomics, geckoId: cachedId } = await readUnlockSnapshot(instrument.id, async (prior, now) => {
    const geckoId = prior?.geckoId ?? (await getDirectory())?.get(instrument.id);
    if (!geckoId) return undefined;
    const result = await fetchUnlockSnapshot({ geckoId, base: instrument.base }, {
      now, prior: prior ?? null,
      request: (url: string, headers?: Record<string, string>) => binanceSpot.fetch(url, "GET", headers),
    });
    return result.refreshed ? result.token as StoredToken : undefined;
  });
  const directory = cachedId ? null : await getDirectory();
  const id = cachedId ?? directory?.get(instrument.id);
  const unlockData = { unlock: tokenomics.events[0] ?? null, tokenomics, unlockSnapshotAt: tokenomics.updatedAt };
  if (!id && !directory) return { ...unlockData, market: null, status: "ready", marketError: true };
  if (!id) return { ...unlockData, market: null, status: "unmapped" };

  const row = await ((id === storedId && seededMarket) || getMarket(id, instrument.coin).catch(() => undefined));
  const price = positiveNumber(row?.current_price);
  const maxSupply = tokenomics.maxSupply ?? positiveNumber(row?.max_supply);
  const supplyLimit = tokenomics.supplyLimit !== "unknown" ? tokenomics.supplyLimit
    : row?.unlimited ? "unlimited" : maxSupply !== null ? "capped" : "unknown";
  const market: CoinValuation | null = row ? {
    price,
    ...marketCapitalization(row),
    totalMarketCap: price !== null && maxSupply !== null && supplyLimit === "capped" ? price * maxSupply : null,
    supplyLimit, maxSupply,
    sourceUrl: row.source === "CoinMarketCap" ? `https://coinmarketcap.com/currencies/${encodeURIComponent((sourceAliases as Record<string, string>)[id] ?? id)}/`
      : `https://www.coingecko.com/en/coins/${encodeURIComponent(id)}`,
  } : null;
  return { ...unlockData, market, status: "ready", marketError: row === undefined };
}
