import ccxt from "ccxt";
import { binanceUsdM } from "./binance-usdm";
import { okxTrade } from "./external-trades";
import type { MarketExchange, MarketInstrument, MarketKind, MarketQuote, VolumeWindow } from "./market-lookup";
import type { AlertRatio } from "./price-alerts";
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

type OkxPair = {
  instId: string; state: string; listTime: string; baseCcy: string; quoteCcy: string;
  uly: string; settleCcy: string; ctType: string; ctValCcy: string; ctVal: string;
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

function number(value: string | number | undefined): number | null {
  if (value == null || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export async function getOkxAlertRatios(instId: string, time: number) {
  const params = { instId, period: "5m", end: time + 1, limit: 2 };
  async function read(path: string): Promise<AlertRatio | null> {
    const rows = await okx<[string, string]>(`rubik/stat/contracts/${path}`, params);
    let latest: AlertRatio | null = null;
    for (const [timestamp, value] of rows) {
      const ts = number(timestamp);
      const ratio = number(value);
      if (ts === null || ts <= 0 || ts > time || ratio === null || ratio < 0 ||
          (latest !== null && ts <= latest.time)) continue;
      const short = 1 / (1 + ratio);
      latest = { time: ts, ratio, long: 1 - short, short };
    }
    return latest;
  }
  const [okxAccounts, okxPositions] = await Promise.all([
    read("long-short-account-ratio-contract").catch(() => null),
    read("long-short-position-ratio-contract-top-trader").catch(() => null),
  ]);
  return { okxAccounts, okxPositions };
}

function change(last: number | null, open: number | null) {
  return last != null && open != null && open > 0 ? (last / open - 1) * 100 : null;
}

export async function getExternalQuote(pair: MarketInstrument): Promise<MarketQuote> {
  const symbol = pair.id;
  const fetchedAt = Date.now();
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

export async function getExternalTurnoverCandles(pair: MarketInstrument, params: CandleParams): Promise<[number, number][]> {
  const candles: [number, number][] = [];
  const bar = params.interval === "1h" ? "1H" : "1m";
  const olderMinutes = params.interval === "1m" && params.startTime < Date.now() - 23 * 60 * 60000;
  const path = olderMinutes ? "market/history-candles" : "market/candles";
  const pageSize = olderMinutes ? 100 : 300;
  // OKX's cursor is exclusive. Use the final millisecond in the requested block
  // so the candle opening at the next boundary cannot consume a result slot.
  let before = params.endTime;
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

export async function getExternalRecentTrades(pair: MarketInstrument, start: number, end: number) {
  const trades: RecentTrade[] = [];
  let cursor: number | undefined;
  let coveredFrom = end;
  for (let page = 0; page < 8; page++) {
    const limit = 100;
    const rows = await okx<Parameters<typeof okxTrade>[0]>("market/history-trades", {
      instId: pair.id, limit, ...(cursor === undefined ? {} : { after: cursor }),
    });
    const batch = rows.map((row) => okxTrade(row, pair.contractSize ?? 1));
    const exhausted = rows.length < limit;
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

export async function getOkxContractTurnover(symbol: string, end: number): Promise<VolumeWindow[]> {
  const minute = 60000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const blocks = [
    { bar: "5m", step: 5 * minute, windows: [["5m", 1]] },
    { bar: "1H", step: hour, windows: [["1h", 1], ["24h", 24]] },
    { bar: "1Dutc", step: day, windows: [["7d", 7]] },
  ] as const;
  const results = await Promise.allSettled(blocks.map(async ({ bar, step, windows }) => {
    const asOf = Math.floor(end / step) * step;
    const limit = Math.max(...windows.map(([, count]) => count));
    const rows = await okx<[string, string, string]>("rubik/stat/taker-volume-contract", {
      instId: symbol, period: bar, unit: 2, end: asOf - 1, limit,
    });
    const amounts = new Map(rows.map(([time, sell, buy]) => [Number(time), { buy: Number(buy), sell: Number(sell) }]));
    const totals: VolumeWindow[] = [];
    for (const [period, count] of windows) {
      let buy = 0;
      let sell = 0;
      let complete = true;
      for (let time = asOf - count * step; time < asOf; time += step) {
        const row = amounts.get(time);
        if (!row || !Number.isFinite(row.buy) || !Number.isFinite(row.sell) || row.buy < 0 || row.sell < 0) {
          complete = false;
          break;
        }
        buy += row.buy;
        sell += row.sell;
      }
      if (complete) totals.push({ period, asOf, amounts: { buy, sell }, total: buy + sell });
    }
    return totals;
  }));
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}
