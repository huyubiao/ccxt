import ccxt from "ccxt";
import { binanceUsdM, getContractDirectory } from "./binance-usdm";
import { getExternalQuote, loadExternalPairs } from "./external-markets";
import {
  CONTRACT_REFRESH_MS, getBinanceBundleCandidate, getBinanceBundledAsset, marketKinds,
  type FuturesContract, type MarketDirectory, type MarketInstrument,
  type MarketExchange, type MarketKind, type MarketListing, type MarketQuote,
} from "./market-lookup";
import type { parseAggregateTrade } from "./short-volume";

export const binanceSpot = new ccxt.binance({
  timeout: binanceUsdM.timeout,
  enableRateLimit: true,
  httpsProxy: binanceUsdM.httpsProxy,
  urls: { api: { public: "https://data-api.binance.vision/api/v3" } },
});

const alphaBase = "https://www.binance.com/bapi/defi/v1/public";
type AlphaPath = `/alpha-trade/${"get-exchange-info" | "ticker" | "fullDepth" | "klines" | "agg-trades"}`
  | "/wallet-direct/buw/wallet/cex/alpha/all/token/list";

async function alphaGet<T>(path: AlphaPath, params?: Record<string, string | number>): Promise<T> {
  const url = new URL(alphaBase + path);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
  const response = await binanceSpot.fetch(url.toString());
  if (response?.code !== "000000" || response.data == null || response.success === false) {
    throw new Error(`Binance Alpha ${path} did not return market data.`);
  }
  return response.data;
}

type ListedPair = {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
};

type AlphaToken = {
  alphaId: string;
  symbol: string;
  name?: string;
  chainName?: string;
  contractAddress?: string;
};

const indexedCoins = new Map<string, { expiresAt: number; pending: Promise<string> }>();

function contractCoin(contract: FuturesContract): string | Promise<string> {
  const base = contract.base.toUpperCase();
  if (contract.type !== "PERPETUAL") return base;
  const known = getBinanceBundledAsset(base);
  if (known) return known.coin;
  const underlying = getBinanceBundleCandidate(base);
  if (!underlying) return base;

  const { id, quote } = contract;
  const cached = indexedCoins.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.pending;
  const entry = { expiresAt: Date.now() + 30 * 60_000, pending: binanceUsdM.fapiPublicGetConstituents({ symbol: id })
    .then((index) => index.symbol === id && Array.isArray(index.constituents) && index.constituents.some((row) =>
      row?.exchange?.toLowerCase() === "binance" && row?.symbol?.toUpperCase() === `${underlying}${quote}`) ? underlying : base)
    .catch(() => { entry.expiresAt = Date.now() + CONTRACT_REFRESH_MS; return base; }) };
  indexedCoins.set(id, entry);
  return entry.pending;
}

// Alpha can use a different ticker from Binance Spot and Futures for the same token.
const alphaCoinByAddress = new Map([
  ["0x6894cde390a3f51155ea41ed24a33a4827d3063d", "1000CAT"],
  ["0x0df0587216a4a1bb7d5082fdc491d93d2dd4b413", "1000CHEEMS"],
]);
const pepeEthereumAddress = "0x6982508145454ce325ddbe47a25d4ec3d2311933";

const load: Record<MarketKind, (maxAge: number) => Promise<MarketInstrument[]>> = {
  async futures(maxAge) {
    const { contracts } = await getContractDirectory(maxAge);
    return Promise.all(contracts.map(async (contract) => ({
      ...contract, kind: "futures", coin: await contractCoin(contract),
    })));
  },
  async spot() {
    const response = await binanceSpot.publicGetExchangeInfo({ symbolStatus: "TRADING", showPermissionSets: false });
    if (!Array.isArray(response.symbols)) throw new Error("Binance Spot symbol list is missing.");
    return (response.symbols as (ListedPair & { isSpotTradingAllowed?: boolean })[])
      .filter((pair) => pair.status === "TRADING" && pair.quoteAsset === "USDT" && pair.isSpotTradingAllowed === true)
      .map((pair) => ({
        kind: "spot", id: pair.symbol, base: pair.baseAsset, coin: pair.baseAsset.toUpperCase(),
        quote: pair.quoteAsset, type: "SPOT", onboardAt: 0,
      }));
  },
  async alpha() {
    const [exchange, tokens] = await Promise.all([
      alphaGet<{ symbols: ListedPair[] }>("/alpha-trade/get-exchange-info"),
      alphaGet<AlphaToken[]>("/wallet-direct/buw/wallet/cex/alpha/all/token/list"),
    ]);
    if (!Array.isArray(exchange.symbols) || !Array.isArray(tokens)) {
      throw new Error("Binance Alpha symbol or token list is missing.");
    }
    const byId = new Map(tokens.map((token) => [token.alphaId, token]));
    return exchange.symbols.filter(({ status, quoteAsset }) => status === "TRADING" && quoteAsset === "USDT").map((pair) => {
      const token = byId.get(pair.baseAsset);
      // Preserve the exchange's pair ID, even if metadata for a new token is still pending.
      const base = token?.symbol?.trim() || pair.baseAsset;
      const ticker = base.toUpperCase();
      const address = token?.contractAddress?.toLowerCase() ?? "";
      // Alpha's TRON PePe is a different token from the PEPE behind 1000PEPE.
      const coin = ticker === "PEPE" && address !== pepeEthereumAddress
        ? pair.baseAsset
        : alphaCoinByAddress.get(address) ?? ticker;
      return {
        kind: "alpha", id: pair.symbol, base, coin,
        quote: pair.quoteAsset, type: "ALPHA", onboardAt: 0,
        name: token?.name, chain: token?.chainName, address: token?.contractAddress,
      };
    });
  },
};

const snapshots = new Map<string, MarketListing>();
const pending = new Map<string, Promise<MarketListing>>();

function getListing(exchange: MarketExchange, kind: MarketKind, maxAge: number): Promise<MarketListing> {
  const key = `${exchange}:${kind}`;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const last = snapshots.get(key);
  if (last?.updatedAt && Date.now() - last.updatedAt < maxAge) return Promise.resolve(last);

  const pairs = exchange === "binance" ? load[kind](maxAge) : loadExternalPairs(exchange, kind);
  const request = pairs.then((instruments) => {
    const next = { instruments, updatedAt: Date.now(), stale: false };
    snapshots.set(key, next);
    return next;
  }).finally(() => { pending.delete(key); });
  pending.set(key, request);
  return request;
}

export async function getMarketDirectory(exchange: MarketExchange = "binance"): Promise<MarketDirectory> {
  const entries = await Promise.all(marketKinds.map(async (kind) => {
    const listing = await getListing(exchange, kind, 3000).catch(() => {
      const last = snapshots.get(`${exchange}:${kind}`);
      return { instruments: last?.instruments ?? [], updatedAt: last?.updatedAt ?? null, stale: true };
    });
    return [kind, listing] as const;
  }));
  return Object.fromEntries(entries) as MarketDirectory;
}

export async function getBinanceFuturesInstruments() {
  return (await getListing("binance", "futures", CONTRACT_REFRESH_MS)).instruments;
}

export async function getBinanceFuturesMarketCaps(contracts: readonly MarketInstrument[]) {
  const response = await binanceSpot.fetch("https://www.binance.com/bapi/composite/v1/public/marketing/symbol/list");
  if (response?.code !== "000000" || response.success === false || !Array.isArray(response.data)) {
    throw new Error("Binance market cap list unavailable.");
  }
  const bySymbol = new Map<string, { base: string; cap: number }>();
  for (const row of response.data) {
    const base = row?.baseAsset;
    const cap = numeric(row?.marketCap);
    if (typeof base !== "string" || !base || row.quoteAsset !== "USDT" ||
        row.symbol !== `${base}USDT` || cap === null || cap <= 0) continue;
    bySymbol.set(row.symbol, { base, cap });
  }

  const caps = new Map<string, number>();
  for (const pair of contracts) {
    if (pair.type !== "PERPETUAL" || pair.quote !== "USDT") continue;
    const exact = bySymbol.get(pair.id);
    if (exact?.base === pair.base) {
      caps.set(pair.id, exact.cap);
      continue;
    }
    const bundle = getBinanceBundledAsset(pair.base);
    // Some bundles share a ticker with an unrelated unbundled asset.
    if (bundle && bundle.coin === bundle.symbol) {
      const underlying = bySymbol.get(`${bundle.symbol}USDT`);
      if (underlying) caps.set(pair.id, underlying.cap);
    }
  }
  return caps;
}

export async function getMarketInstrument(kind: MarketKind, symbol: string, exchange: MarketExchange = "binance") {
  const listing = await getListing(exchange, kind, CONTRACT_REFRESH_MS).catch((error) => {
    const last = snapshots.get(`${exchange}:${kind}`);
    if (!last) throw error;
    return last;
  });
  return listing.instruments.find(({ id }) => id === symbol);
}

export async function findOkxPerpetuals(pair: MarketInstrument) {
  const listing = await getListing("okx", "futures", CONTRACT_REFRESH_MS);
  return listing.instruments.filter(({ coin, quote }) => coin === pair.coin && quote === pair.quote);
}

type KlineParams = { interval: string; startTime: number; endTime: number; limit: number };

export async function getKlines({ kind, id: symbol }: MarketInstrument, params: KlineParams): Promise<unknown[][]> {
  if (kind === "alpha") return alphaGet("/alpha-trade/klines", { symbol, ...params });
  const request = { ...params, symbol, maxRetriesOnFailure: 1, maxRetriesOnFailureDelay: 400 };
  return kind === "spot" ? binanceSpot.publicGetKlines(request) : binanceUsdM.fapiPublicGetKlines(request);
}

type TradeParams = { startTime: number; endTime: number; limit: number } | { fromId: number; limit: number };
type RawTrade = Parameters<typeof parseAggregateTrade>[0];

export async function getAggregateTrades({ kind, id: symbol }: MarketInstrument, params: TradeParams): Promise<RawTrade[]> {
  if (kind === "alpha") return alphaGet("/alpha-trade/agg-trades", { symbol, ...params });
  const request = { ...params, symbol, maxRetriesOnFailure: 1 };
  return kind === "spot" ? binanceSpot.publicGetAggTrades(request) : binanceUsdM.fapiPublicGetAggTrades(request);
}

type Ticker = { symbol: string; lastPrice?: string; priceChangePercent?: string; volume?: string; closeTime?: number };
type Book = { symbol: string; bidPrice?: string; askPrice?: string };

function numeric(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export async function getMarketQuote(pair: MarketInstrument): Promise<MarketQuote> {
  if (pair.exchange && pair.exchange !== "binance") return getExternalQuote(pair);
  const { kind, id: symbol } = pair;
  const params = { symbol };
  const ticker = kind === "alpha" ? alphaGet<Ticker>("/alpha-trade/ticker", params)
    : kind === "spot" ? binanceSpot.publicGetTicker24hr(params) : binanceUsdM.fapiPublicGetTicker24hr(params);
  const book = kind === "alpha"
    ? alphaGet<{ symbol: string; bids?: string[][]; asks?: string[][] }>("/alpha-trade/fullDepth", { symbol, limit: 5 })
      .then(({ symbol, bids, asks }): Book => ({ symbol, bidPrice: bids?.[0]?.[0], askPrice: asks?.[0]?.[0] }))
    : kind === "spot" ? binanceSpot.publicGetTickerBookTicker(params) : binanceUsdM.fapiPublicGetTickerBookTicker(params);
  const [last, best] = await Promise.all([ticker, book.catch(() => null)]);
  if (Array.isArray(last) || last?.symbol !== symbol) throw new Error("Unexpected Binance ticker response.");
  const prices = best && !Array.isArray(best) && best.symbol === symbol ? best : null;
  return {
    symbol, last: numeric(last.lastPrice), bid: numeric(prices?.bidPrice), ask: numeric(prices?.askPrice),
    changePercent: numeric(last.priceChangePercent), baseVolume: numeric(last.volume),
    timestamp: numeric(last.closeTime), fetchedAt: Date.now(),
  };
}
