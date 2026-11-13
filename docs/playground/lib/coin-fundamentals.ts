import { binanceSpot, getBinanceFuturesInstruments, getBinanceFuturesMarketCaps, getMarketInstrument } from "./binance-markets";
import { getContractSupplyValuation } from "./binance-usdm";
import { positiveNumber, type CoinOverview, type CoinValuation } from "./coin-overview";
import {
  MARKET_CAP_REFRESH_MS, MARKET_CAP_RETRY_MS, type ContractMarketCapSnapshot, type MissingContractMarketCap,
} from "./market-cap-filter";
import { getBinanceBundledAsset, type MarketInstrument } from "./market-lookup";
import { getStoredIdentity, readUnlockSnapshot, type StoredToken } from "./coin-unlocks";
import { fetchUnlockSnapshot } from "../scripts/fetch-unlock-snapshot.mjs";
import sourceAliases from "./coin-source-aliases.json";

type MarketIdentity = { symbol: string; target: string; coin_id: string; contract_type: string };
type CoinGeckoMarket = {
  id: string; symbol: string; current_price: number | null;
  market_cap: number | null; total_supply: number | null; last_updated: string | null;
  circulating_supply?: number | null;
  max_supply?: number | null;
  unlimited?: boolean;
  source?: "CoinMarketCap" | "币安持仓数据估算";
};
type CmcMarket = {
  data?: {
    id: number; slug: string; symbol: string; lastUpdated?: string; isInfiniteMaxSupply?: number;
    platforms?: { contractId: number; contractChainId: number; contractAddress: string; contractPlatform: string }[];
    statistics?: { price?: number; marketCap?: number; circulatingSupply?: number; totalSupply?: number; maxSupply?: number; lastUpdated?: string };
  };
};
type CmcQuote = { slug: string; symbol: string; quotes: { symbol: string; market_cap?: number }[] };

const MINUTE = 60_000;
const RECENT_CAP_MS = 20 * MINUTE;
const CMC_FALLBACK_LIMIT = 8;
const marketCache = new Map<string, { expiresAt: number; pending: Promise<CoinGeckoMarket | null> }>();
const recentCaps = new Map<string, { value: number; fetchedAt: number }>();
const recentContractCaps = new Map<string, { value: number; fetchedAt: number }>();
const estimatedMarkets = new Map<string, { expiresAt: number; pending: Promise<CoinGeckoMarket | null> }>();
const fallbackAttempts = new Map<string, number>();
let identities: { expiresAt: number; pending: Promise<Map<string, string>> } | undefined;
let coinIdsBySymbol: { expiresAt: number; pending: Promise<Map<string, string[]>> } | undefined;
const spotIdentities = new Map<string, { expiresAt: number; pending: Promise<string | undefined> }>();
let contractCaps: { expiresAt: number; pending: Promise<ContractMarketCapSnapshot> } | undefined;

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

function verifiedIdentity(instrument: MarketInstrument) {
  return getBinanceBundledAsset(instrument.base)?.geckoId ?? (instrument.id === "USTCUSDT" ? "terrausd" : undefined);
}

function knownIdentity(instrument: MarketInstrument) {
  return verifiedIdentity(instrument) ?? (instrument.base === instrument.coin ? getStoredIdentity(instrument.id) : undefined);
}

async function getListedIdentity(instrument: MarketInstrument) {
  const known = knownIdentity(instrument);
  if (known) return known;
  if (instrument.base !== instrument.coin) {
    const spot = await getSpotIdentity(instrument.coin).catch(() => undefined);
    if (spot) return spot;
  }
  return (await getIdentities()).get(instrument.id);
}

function getCoinIdsBySymbol() {
  if (coinIdsBySymbol && coinIdsBySymbol.expiresAt > Date.now()) return coinIdsBySymbol.pending;
  const pending = gecko<{ id: string; symbol: string }[]>("coins/list").then((rows) => {
    if (!Array.isArray(rows)) throw new Error("CoinGecko coin list unavailable.");
    const index = new Map<string, string[]>();
    for (const { id, symbol } of rows) {
      const key = symbol.toUpperCase();
      const matches = index.get(key) ?? [];
      matches.push(id);
      index.set(key, matches);
    }
    return index;
  }).catch((error) => {
    if (coinIdsBySymbol?.pending === pending) coinIdsBySymbol = undefined;
    throw error;
  });
  coinIdsBySymbol = { expiresAt: Date.now() + 30 * MINUTE, pending };
  return pending;
}

function getSpotIdentity(coin: string) {
  const cached = spotIdentities.get(coin);
  if (cached && cached.expiresAt > Date.now()) return cached.pending;
  const pending = (async () => {
    const spot = await getMarketInstrument("spot", `${coin}USDT`);
    if (spot?.base !== coin || spot.quote !== "USDT") return undefined;
    const ids = (await getCoinIdsBySymbol()).get(coin);
    if (!ids?.length) return undefined;
    const params = new URLSearchParams({ coin_ids: ids.join(",") });
    const { tickers } = await gecko<{ tickers: { base: string; target: string; coin_id: string }[] }>(`exchanges/binance/tickers?${params}`);
    if (!Array.isArray(tickers)) throw new Error("CoinGecko spot tickers unavailable.");
    const matches = new Set(tickers.filter(({ base, target, coin_id }) => base === spot.base && target === spot.quote &&
      ids.includes(coin_id)).map(({ coin_id }) => coin_id));
    return matches.size === 1 ? [...matches][0] : undefined;
  })().catch((error) => {
    if (spotIdentities.get(coin)?.pending === pending) spotIdentities.delete(coin);
    throw error;
  });
  spotIdentities.set(coin, { expiresAt: Date.now() + 30 * MINUTE, pending });
  return pending;
}

export async function getResearchIdentity(instrument: MarketInstrument) {
  return getListedIdentity(instrument).then(
    (listed) => listed ?? getSpotIdentity(instrument.coin),
    async (error) => {
      const spot = await getSpotIdentity(instrument.coin);
      if (spot) return spot;
      throw error;
    },
  );
}

export async function getDailyMarketCaps(instrument: MarketInstrument, days: number): Promise<[number, number][]> {
  const id = await getResearchIdentity(instrument);
  if (!id) return [];
  const { market_caps } = await gecko<{ market_caps?: [number, number][] }>(
    `coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}&interval=daily`,
  );
  return Array.isArray(market_caps) ? market_caps : [];
}

function cmcSlug(id: string) {
  return (sourceAliases as Record<string, string>)[id] ?? id;
}

export async function getCmcDetail(id: string, symbol: string) {
  const slug = cmcSlug(id);
  const { data } = await binanceSpot.fetch(
    `https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail?slug=${encodeURIComponent(slug)}`,
  ) as CmcMarket;
  if (data?.slug !== slug || data.symbol?.toUpperCase() !== symbol || !data.statistics) return null;
  return data;
}

async function fillCmcMarketCaps(coins: ReadonlyMap<string, string>) {
  const missing = [...coins].filter(([id]) => recentCap(id, recentCaps, MARKET_CAP_REFRESH_MS) === undefined &&
    /^[a-z0-9-]+$/.test(cmcSlug(id)));
  for (let start = 0; start < missing.length; start += 100) {
    const batch = missing.slice(start, start + 100);
    const params = new URLSearchParams({
      slug: [...new Set(batch.map(([id]) => cmcSlug(id)))].join(","),
      convert: "USD", include_market_cap: "true", skip_invalid: "true",
    });
    const { data } = await binanceSpot.fetch(
      `https://pro-api.coinmarketcap.com/public-api/v2/simple/price?${params}`,
    ) as { data?: CmcQuote[] };
    if (!Array.isArray(data)) throw new Error("CoinMarketCap batch quotes unavailable.");
    const bySlug = new Map(data.map((row) => [row.slug, row]));
    for (const [id, symbol] of batch) {
      if (recentCap(id, recentCaps, MARKET_CAP_REFRESH_MS) !== undefined) continue;
      const row = bySlug.get(cmcSlug(id));
      if (row?.symbol?.toUpperCase() !== symbol || !Array.isArray(row.quotes)) continue;
      const cap = positiveNumber(row.quotes.find((quote) => quote.symbol === "USD")?.market_cap);
      if (cap !== null) recentCaps.set(id, { value: cap, fetchedAt: Date.now() });
    }
  }
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
    total_supply: stats.totalSupply ?? null, circulating_supply: stats.circulatingSupply ?? null,
    last_updated: stats.lastUpdated ?? data.lastUpdated ?? null,
    max_supply: stats.maxSupply ?? null, unlimited: data.isInfiniteMaxSupply === 1,
    source: "CoinMarketCap",
  };
}

async function getGeckoMarkets(ids: string[]): Promise<CoinGeckoMarket[]> {
  const params = new URLSearchParams({ vs_currency: "usd", ids: ids.join(","), per_page: String(ids.length) });
  const rows = await gecko<CoinGeckoMarket[]>(`coins/markets?${params}`);
  if (!Array.isArray(rows)) throw new Error("CoinGecko market data unavailable.");
  return rows;
}

async function loadContractMarketCaps(): Promise<ContractMarketCapSnapshot> {
  const listed = (await getBinanceFuturesInstruments()).filter(({ type }) => type === "PERPETUAL");
  const capsByContract = await getBinanceFuturesMarketCaps(listed).catch(() => new Map<string, number>());
  const fetchedAt = Date.now();
  for (const [symbol, cap] of capsByContract) recentContractCaps.set(symbol, { value: cap, fetchedAt });
  const contracts = listed.filter(({ id }) => !capsByContract.has(id));
  const mappings = await Promise.allSettled(contracts.map(async (pair) => ({ pair, id: await getListedIdentity(pair) })));
  const coins = new Map<string, string>();
  let incomplete = false;
  for (const mapping of mappings) {
    if (mapping.status === "rejected") incomplete = true;
    else if (mapping.value.id) {
      const { id, pair } = mapping.value;
      coins.set(id, getBinanceBundledAsset(pair.base)?.symbol ?? pair.coin);
    }
  }

  const ids = [...coins.keys()].filter((id) => !cachedMarket(id));
  const failed = new Map<string, unknown>();
  const capless = new Map<string, CoinGeckoMarket | null>();
  const batches: Promise<void>[] = [];
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100);
    batches.push(getGeckoMarkets(batch).then(async (rows) => {
      const byId = new Map(rows.map((row) => [row.id, row]));
      const results = await Promise.allSettled(batch.map((id) => {
        const cached = cachedMarket(id);
        if (cached) return cached;
        const row = byId.get(id) ?? null;
        if (row && marketCapitalization(row).circulatingMarketCap !== null) {
          return cacheMarket(id, Promise.resolve(row));
        }
        capless.set(id, row);
      }));
      results.forEach((result, index) => {
        if (result.status === "rejected") failed.set(batch[index], result.reason);
      });
    }).catch((error) => {
      for (const id of batch) failed.set(id, error);
    }));
  }
  await Promise.all(batches);

  if (failed.size) incomplete = true;

  const coinIds = [...coins.keys()];
  const cached = await Promise.allSettled(coinIds.map(cachedMarket));
  cached.forEach((result, index) => {
    if (result.status === "rejected") {
      failed.set(coinIds[index], result.reason);
      incomplete = true;
    }
  });
  try {
    await fillCmcMarketCaps(coins);
  } catch {
    incomplete = true;
  }
  // Keep per-asset fallback requests bounded during upstream outages.
  const candidates = contracts.map((pair, index) => {
    const mapping = mappings[index];
    return { pair, id: mapping.status === "fulfilled" ? mapping.value.id : undefined };
  }).filter(({ pair, id }) => recentCap(pair.id, recentContractCaps) === undefined &&
    (!id || recentCap(id) === undefined));
  const verified = candidates.filter(({ pair }) => verifiedIdentity(pair));
  const other = candidates.filter(({ pair }) => !verifiedIdentity(pair));
  if (other.length > CMC_FALLBACK_LIMIT) incomplete = true;
  other.sort((a, b) => (fallbackAttempts.get(a.pair.id) ?? 0) - (fallbackAttempts.get(b.pair.id) ?? 0));
  const deferred = new Set(other.slice(CMC_FALLBACK_LIMIT).map(({ pair }) => pair.id));
  await Promise.all([...verified, ...other.slice(0, CMC_FALLBACK_LIMIT)].map(async ({ pair, id }) => {
    fallbackAttempts.set(pair.id, Date.now());
    const lookup = id && (failed.has(id) ? () => Promise.reject(failed.get(id))
      : capless.has(id) ? () => Promise.resolve(capless.get(id) ?? null) : undefined);
    const resolvedId = id ?? await getSpotIdentity(pair.coin).catch(() => undefined);
    await getInstrumentMarket(pair, resolvedId, lookup || undefined);
  }));
  const missing: MissingContractMarketCap[] = [];
  for (const [index, mapping] of mappings.entries()) {
    const symbol = contracts[index].id;
    const id = mapping.status === "fulfilled" ? mapping.value.id : undefined;
    const cap = (id ? recentCap(id) : undefined) ?? recentCap(symbol, recentContractCaps);
    if (cap !== undefined) {
      capsByContract.set(symbol, cap);
      continue;
    }
    if (deferred.has(symbol)) {
      missing.push({ symbol, reason: "fallback-pending" });
      continue;
    }
    missing.push({ symbol, reason: mapping.status === "rejected" ? "identity-unavailable"
      : !id ? "unmapped" : failed.has(id) ? "cap-unavailable" : "cap-missing" });
  }
  if (incomplete && !capsByContract.size) throw new Error("No market caps available from the research data sources.");
  return { caps: Object.fromEntries(capsByContract), total: listed.length, incomplete: incomplete && missing.length > 0, missing };
}

export function getContractMarketCaps(): Promise<ContractMarketCapSnapshot> {
  if (contractCaps && Date.now() < contractCaps.expiresAt) return contractCaps.pending;
  const next = { expiresAt: Infinity, pending: loadContractMarketCaps() };
  contractCaps = next;
  void next.pending.then(
    ({ incomplete }) => { next.expiresAt = Date.now() + (incomplete ? MARKET_CAP_RETRY_MS : MARKET_CAP_REFRESH_MS); },
    () => { next.expiresAt = Date.now() + MARKET_CAP_RETRY_MS; },
  );
  return next.pending;
}

function cachedMarket(id: string) {
  const cached = marketCache.get(id);
  return cached && Date.now() < cached.expiresAt ? cached.pending : undefined;
}

function recentCap(id: string, cache = recentCaps, maxAge = RECENT_CAP_MS) {
  const cached = cache.get(id);
  return cached && Date.now() - cached.fetchedAt < maxAge ? cached.value : undefined;
}

function cacheMarket(id: string, request: Promise<CoinGeckoMarket | null>) {
  const pending = request.then((row) => {
    const cap = row ? marketCapitalization(row).circulatingMarketCap : null;
    if (cap !== null) recentCaps.set(id, { value: cap, fetchedAt: Date.now() });
    return row;
  }).catch((error) => {
      if (marketCache.get(id)?.pending === pending) marketCache.delete(id);
      throw error;
    });
  marketCache.set(id, { expiresAt: Date.now() + MINUTE, pending });
  return pending;
}

function getMarket(id: string, symbol: string, fromGecko?: () => Promise<CoinGeckoMarket | null>) {
  const cached = cachedMarket(id);
  if (cached) return cached;
  const gecko = fromGecko?.() ?? getGeckoMarkets([id]).then((rows) => rows.find((row) => row.id === id) ?? null);
  return cacheMarket(id, gecko.then(async (row) => {
    if (row && marketCapitalization(row).circulatingMarketCap !== null) return row;
    const alternative = await getCmcMarket(id, symbol).catch(() => null);
    return alternative && marketCapitalization(alternative).circulatingMarketCap !== null ? alternative : row ?? alternative;
  }, async (error) => {
    const alternative = await getCmcMarket(id, symbol).catch(() => null);
    if (alternative) return alternative;
    throw error;
  }));
}

function marketCapitalization(row: CoinGeckoMarket) {
  const price = positiveNumber(row.current_price);
  const supply = positiveNumber(row.circulating_supply);
  return {
    circulatingMarketCap: positiveNumber(row.market_cap) ?? (price !== null && supply !== null ? positiveNumber(price * supply) : null),
    updatedAt: row.last_updated ? positiveNumber(Date.parse(row.last_updated)) : null,
    sourceName: row.source ?? "CoinGecko",
  };
}

function getEstimatedMarket(instrument: MarketInstrument) {
  const cached = estimatedMarkets.get(instrument.id);
  if (cached && cached.expiresAt > Date.now()) return cached.pending;
  const pending = getContractSupplyValuation(instrument).then((valuation): CoinGeckoMarket | null => valuation && ({
    id: instrument.id, symbol: instrument.coin, current_price: valuation.price, market_cap: valuation.marketCap,
    last_updated: new Date(valuation.time).toISOString(), total_supply: null, source: "币安持仓数据估算",
  })).catch(() => null);
  estimatedMarkets.set(instrument.id, { expiresAt: Date.now() + MINUTE, pending });
  return pending;
}

async function getInstrumentMarket(instrument: MarketInstrument, id?: string, fromGecko?: () => Promise<CoinGeckoMarket | null>) {
  const symbol = getBinanceBundledAsset(instrument.base)?.symbol ?? instrument.coin;
  const row = id ? await getMarket(id, symbol, fromGecko).catch(() => undefined) : null;
  const estimate = row && marketCapitalization(row).circulatingMarketCap !== null ? null : await getEstimatedMarket(instrument);
  const market = estimate ? { ...row, ...estimate } : row;
  const cap = market ? marketCapitalization(market).circulatingMarketCap : null;
  if (cap !== null) recentContractCaps.set(instrument.id, { value: cap, fetchedAt: Date.now() });
  return market;
}

export async function getCirculatingMarketCap(instrument: MarketInstrument) {
  if (instrument.type === "TRADIFI_PERPETUAL") return null;
  const id = await getResearchIdentity(instrument).catch(() => undefined);
  const row = await getInstrumentMarket(instrument, id);
  return row ? marketCapitalization(row) : null;
}

export async function getCoinOverview(instrument: MarketInstrument): Promise<CoinOverview> {
  if (instrument.type === "TRADIFI_PERPETUAL") return { market: null, unlock: null, tokenomics: null, status: "not-applicable" };
  const verifiedId = verifiedIdentity(instrument);
  const storedId = knownIdentity(instrument);
  const seededMarket = storedId ? getInstrumentMarket(instrument, storedId) : null;
  let lookup: Promise<string | undefined> | undefined;
  let identityError = false;
  const resolveIdentity = () => lookup ??= getResearchIdentity(instrument).catch(() => {
    identityError = true;
    return undefined;
  });
  const preferredId = verifiedId ?? (instrument.base !== instrument.coin ? await resolveIdentity() : undefined);
  const symbol = getBinanceBundledAsset(instrument.base)?.symbol ?? instrument.coin;
  const { tokenomics, geckoId: cachedId } = await readUnlockSnapshot(instrument.id, async (prior, now) => {
    const geckoId = preferredId ?? prior?.geckoId ?? storedId ?? await resolveIdentity();
    if (!geckoId) return undefined;
    const result = await fetchUnlockSnapshot({ geckoId, base: symbol }, {
      now, prior: prior ?? null,
      request: (url: string, headers?: Record<string, string>) => binanceSpot.fetch(url, "GET", headers),
    });
    return result.refreshed ? result.token as StoredToken : undefined;
  });
  const id = preferredId ?? cachedId ?? storedId ?? await resolveIdentity();
  const unlockData = { unlock: tokenomics.events[0] ?? null, tokenomics, unlockSnapshotAt: tokenomics.updatedAt };
  const row = await ((id === storedId ? seededMarket : null) ?? getInstrumentMarket(instrument, id));
  if (!row && !id && !identityError) return { ...unlockData, market: null, status: "unmapped" };
  const price = positiveNumber(row?.current_price);
  const maxSupply = tokenomics.maxSupply ?? positiveNumber(row?.max_supply);
  const supplyLimit = tokenomics.supplyLimit !== "unknown" ? tokenomics.supplyLimit
    : row?.unlimited ? "unlimited" : maxSupply !== null ? "capped" : "unknown";
  const market: CoinValuation | null = row ? {
    price,
    ...marketCapitalization(row),
    totalMarketCap: price !== null && maxSupply !== null && supplyLimit === "capped" ? price * maxSupply : null,
    supplyLimit, maxSupply,
    sourceUrl: row.source === "币安持仓数据估算"
      ? "https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#open-interest-statistics"
      : row.source === "CoinMarketCap" ? `https://coinmarketcap.com/currencies/${encodeURIComponent(cmcSlug(row.id))}/`
      : `https://www.coingecko.com/en/coins/${encodeURIComponent(row.id)}`,
  } : null;
  return { ...unlockData, market, status: "ready", marketError: row === undefined || (identityError && !row) };
}
