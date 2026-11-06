import ccxt from "ccxt";
import { binanceUsdM } from "./binance-usdm";
import { coinbasePerpetualTrade, coinbaseSpotTrade, okxTrade } from "./external-trades";
import type { MarketExchange, MarketInstrument, MarketKind, MarketQuote } from "./market-lookup";
import type { RecentTrade } from "./short-volume";

type ExternalExchange = Exclude<MarketExchange, "binance">;
type Params = Record<string, string | number>;
type CandleParams = { interval: string; startTime: number; endTime: number; limit: number };

const client = new ccxt.Exchange({ timeout: 8000, httpsProxy: binanceUsdM.httpsProxy });

async function request<T>(base: string, path: string, params: Params = {}): Promise<T> {
  const url = new URL(base + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  try {
    return await client.fetch(url.toString());
  } catch (error) {
    if (!(error instanceof ccxt.NetworkError) || error instanceof ccxt.RateLimitExceeded ||
        error instanceof ccxt.DDoSProtection) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return client.fetch(url.toString());
  }
}

async function okx<T>(path: string, params: Params) {
  const response = await request<{ code: string; data: T[] }>("https://www.okx.com/api/v5/", path, params);
  if (response.code === "50011") throw new ccxt.RateLimitExceeded("OKX public data rate limit.");
  if (response.code !== "0" || !Array.isArray(response.data)) throw new Error("OKX public data unavailable.");
  return response.data;
}

function coinbase<T>(path: string, params?: Params) {
  return request<T>("https://api.exchange.coinbase.com/", path, params);
}

async function derivatives<T>(method: string, params: Params): Promise<T> {
  const response = await request<{ result?: T }>("https://www.deribit.com/api/v2/public/", method, params);
  if (response.result == null) throw new Error("Deribit by Coinbase public data unavailable.");
  return response.result;
}

type OkxPair = {
  instId: string; state: string; listTime: string; baseCcy: string; quoteCcy: string;
  uly: string; settleCcy: string; ctType: string; ctValCcy: string; ctVal: string;
};
type CoinbasePair = {
  id: string; base_currency: string; quote_currency: string; status: string;
  trading_disabled: boolean; cancel_only: boolean; auction_mode: boolean;
};
type CoinbasePerpetual = {
  instrument_name: string; base_currency: string; quote_currency: string; settlement_currency: string;
  settlement_period: string; instrument_type: string; is_active: boolean; creation_timestamp: number;
};

// Group these OKX instruments under the code Binance uses for the same asset.
// In particular, OKX CAT spot is Simon's Cat, while Binance CATUSDT is Caterpillar.
const okxCoinByInstrument = new Map([
  ["CAT-USDT", "1000CAT"],
  ["SATS-USDT", "1000SATS"],
  ["SATS-USDT-SWAP", "1000SATS"],
  ["BABYDOGE-USDT", "1MBABYDOGE"],
]);

export async function loadExternalPairs(exchange: ExternalExchange, kind: MarketKind): Promise<MarketInstrument[]> {
  if (kind === "alpha") return [];
  if (exchange === "okx") {
    const spot = kind === "spot";
    const rows = await okx<OkxPair>("public/instruments", { instType: spot ? "SPOT" : "SWAP" });
    const instruments: MarketInstrument[] = [];
    for (const row of rows) {
      const [base, quote] = spot ? [row.baseCcy, row.quoteCcy] : row.uly.split("-");
      if (row.state !== "live" || quote !== "USDT" || !base) continue;
      const contractSize = spot ? 1 : Number(row.ctVal);
      if (!spot && (row.settleCcy !== quote || row.ctType !== "linear" ||
          row.ctValCcy !== base || !Number.isFinite(contractSize) || contractSize <= 0)) continue;
      instruments.push({
        exchange, kind, id: row.instId, base, quote, coin: okxCoinByInstrument.get(row.instId) ?? base, contractSize,
        type: spot ? "SPOT" : "PERPETUAL", onboardAt: Number(row.listTime) || 0,
      });
    }
    return instruments;
  }

  if (kind === "spot") {
    const rows = await coinbase<CoinbasePair[]>("products");
    return rows.filter((row) => row.status === "online" && !row.trading_disabled &&
      !row.cancel_only && !row.auction_mode && row.quote_currency === "USDT")
      .map((row) => ({
        exchange, kind, id: row.id, base: row.base_currency, quote: row.quote_currency,
        coin: row.base_currency, type: "SPOT", onboardAt: 0,
      }));
  }

  const rows = await derivatives<CoinbasePerpetual[]>("get_instruments", { currency: "any", kind: "future" });
  return rows.filter((row) => row.is_active && row.instrument_type === "linear" &&
    row.settlement_period === "perpetual" && row.quote_currency === "USDT" && row.settlement_currency === "USDT")
    .map((row) => ({
      exchange, kind, id: row.instrument_name, base: row.base_currency, quote: row.quote_currency,
      coin: row.base_currency, type: "PERPETUAL", onboardAt: row.creation_timestamp,
    }));
}

function number(value: string | number | undefined): number | null {
  if (value == null || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function change(last: number | null, open: number | null) {
  return last != null && open != null && open > 0 ? (last / open - 1) * 100 : null;
}

export async function getExternalQuote(pair: MarketInstrument): Promise<MarketQuote> {
  const symbol = pair.id;
  const fetchedAt = Date.now();
  if (pair.exchange === "okx") {
    const [row] = await okx<{
      last: string; bidPx: string; askPx: string; open24h: string; volCcy24h: string; vol24h: string; ts: string;
    }>("market/ticker", { instId: symbol });
    const last = number(row.last);
    return {
      symbol, fetchedAt, last, bid: number(row.bidPx), ask: number(row.askPx),
      changePercent: change(last, number(row.open24h)),
      baseVolume: number(pair.kind === "spot" ? row.vol24h : row.volCcy24h), timestamp: number(row.ts),
    };
  }
  if (pair.kind === "futures") {
    const row = await derivatives<{
      last_price: number; best_bid_price: number; best_ask_price: number; timestamp: number;
      stats: { price_change: number; volume: number };
    }>("ticker", { instrument_name: symbol });
    return {
      symbol, fetchedAt, last: number(row.last_price), bid: number(row.best_bid_price), ask: number(row.best_ask_price),
      changePercent: number(row.stats.price_change), baseVolume: number(row.stats.volume), timestamp: number(row.timestamp),
    };
  }
  const product = `products/${encodeURIComponent(symbol)}`;
  const [ticker, stats] = await Promise.all([
    coinbase<{ price: string; bid: string; ask: string; time: string; volume: string }>(`${product}/ticker`),
    coinbase<{ open: string }>(`${product}/stats`).catch(() => null),
  ]);
  const last = number(ticker.price);
  return {
    symbol, fetchedAt, last, bid: number(ticker.bid), ask: number(ticker.ask),
    changePercent: change(last, number(stats?.open)), baseVolume: number(ticker.volume),
    timestamp: number(Date.parse(ticker.time)),
  };
}

export function getCoinbaseCandles(symbol: string, params: CandleParams) {
  return coinbase<[number, number, number, number, number, number][]>(
    `products/${encodeURIComponent(symbol)}/candles`,
    {
      start: new Date(params.startTime).toISOString(),
      end: new Date(params.endTime).toISOString(),
      granularity: params.interval === "1h" ? 3600 : 60,
    },
  );
}

export async function getExternalTurnoverCandles(pair: MarketInstrument, params: CandleParams): Promise<[number, number][]> {
  if (pair.exchange === "okx") {
    const candles: [number, number][] = [];
    const bar = params.interval === "1h" ? "1H" : "1m";
    const olderMinutes = params.interval === "1m" && params.startTime < Date.now() - 23 * 60 * 60000;
    const path = olderMinutes ? "market/history-candles" : "market/candles";
    const pageSize = olderMinutes ? 100 : 300;
    let before = params.endTime + 1;
    for (let page = 0; page < Math.ceil(params.limit / pageSize); page++) {
      const rows = await okx<string[]>(path, {
        instId: pair.id, bar, after: before, limit: Math.min(pageSize, params.limit - page * pageSize),
      });
      if (rows.length === 0) break;
      for (const [time, , , , , , , total, confirmed] of rows) {
        if (confirmed === "1") candles.push([Number(time), Number(total)]);
      }
      const oldest = Number(rows.at(-1)?.[0]);
      if (!Number.isFinite(oldest) || oldest >= before || oldest <= params.startTime) break;
      before = oldest;
    }
    return candles;
  }
  if (pair.kind === "futures") {
    const response = await derivatives<{ ticks?: number[]; cost?: number[] }>("get_tradingview_chart_data", {
      instrument_name: pair.id, start_timestamp: params.startTime, end_timestamp: params.endTime,
      resolution: params.interval === "1h" ? "60" : "1",
    });
    return (response.ticks ?? []).map((time, i) => [time, response.cost?.[i] ?? NaN]);
  }
  const rows = await getCoinbaseCandles(pair.id, params);
  const turnover = new Map(rows.map(([time, , , , close, volume]) => [time * 1000, close * volume]));
  // Coinbase Exchange omits candle intervals with no trades.
  const step = params.interval === "1h" ? 3600000 : 60000;
  const candles: [number, number][] = [];
  for (let time = params.startTime; time <= params.endTime; time += step) candles.push([time, turnover.get(time) ?? 0]);
  return candles;
}

export async function getExternalRecentTrades(pair: MarketInstrument, start: number, end: number) {
  const trades: RecentTrade[] = [];
  let cursor: number | undefined;
  let coveredFrom = end;
  for (let page = 0; page < 8; page++) {
    let batch: RecentTrade[];
    let exhausted: boolean;
    if (pair.exchange === "okx") {
      const limit = 100;
      const rows = await okx<Parameters<typeof okxTrade>[0]>("market/history-trades", {
        instId: pair.id, limit, ...(cursor === undefined ? {} : { after: cursor }),
      });
      batch = rows.map((row) => okxTrade(row, pair.contractSize ?? 1));
      exhausted = rows.length < limit;
    } else if (pair.kind === "futures") {
      const data = await derivatives<{ trades: Parameters<typeof coinbasePerpetualTrade>[0][]; has_more: boolean }>(
        "get_last_trades_by_instrument", {
          instrument_name: pair.id, count: 1000, sorting: "desc",
          ...(cursor === undefined ? {} : { end_seq: cursor - 1 }),
        },
      );
      batch = data.trades.map(coinbasePerpetualTrade);
      exhausted = !data.has_more;
    } else {
      const limit = 1000;
      const rows = await coinbase<Parameters<typeof coinbaseSpotTrade>[0][]>(
        `products/${encodeURIComponent(pair.id)}/trades`, { limit, ...(cursor === undefined ? {} : { after: cursor }) },
      );
      batch = rows.map(coinbaseSpotTrade);
      exhausted = rows.length < limit;
    }
    trades.push(...batch.filter(({ time }) => time >= start && time < end));
    const oldest = batch.at(-1);
    if (exhausted || (oldest && oldest.time < start)) return { trades, coveredFrom: start };
    if (!oldest || (cursor !== undefined && oldest.id >= cursor)) break;
    // The oldest millisecond may be shared by trades on the next page.
    coveredFrom = Math.min(coveredFrom, oldest.time + 1);
    cursor = oldest.id;
  }
  return { trades, coveredFrom };
}
