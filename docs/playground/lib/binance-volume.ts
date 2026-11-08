import ccxt from "ccxt";
import { binanceSpot, getAggregateTrades, getKlines } from "./binance-markets";
import { getExternalRecentTrades, getExternalTurnoverCandles, getOkxContractTurnover } from "./external-markets";
import type { MarketInstrument, MarketVolume, VolumeWindow } from "./market-lookup";
import {
  MINUTE_MS as MINUTE, VOLUME_DELAY_MS, parseAggregateTrade, shortPeriods, sumShortVolume,
  type RecentTrade, type RecentVolumeSeed,
} from "./short-volume";

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const AGG_TRADE_PAGE_SIZE = 1000;
const MAX_AGG_TRADE_PAGES = 12;

type CandleBlock = {
  start: number;
  end: number;
  step: number;
  volumes: Map<number, { total: number; buy: number }>;
};

export async function getMarketVolume(contract: MarketInstrument, historyOnly = false): Promise<MarketVolume> {
  // Give the exchange a moment to publish trades and the last closed candle.
  const shortAsOf = Date.now() - VOLUME_DELAY_MS;
  const end = Math.floor(shortAsOf / MINUTE) * MINUTE;
  const lastHour = Math.floor(end / HOUR) * HOUR;
  const firstDayHour = Math.ceil((end - DAY) / HOUR) * HOUR;
  const firstWeekHour = Math.ceil((end - WEEK) / HOUR) * HOUR;
  const shortTotalOnly = contract.kind === "alpha";
  const external = contract.exchange != null && contract.exchange !== "binance";
  const totalOnly = shortTotalOnly || external;

  function olderBlock(start: number, stop: number, step: number) {
    const block = fetchBlock(contract, start, stop, step);
    if (!external) return block;
    return block.catch((): CandleBlock => ({ start, end: stop, step, volumes: new Map() }));
  }

  // Full hours cover the middle of longer windows. Minutes cover their
  // unaligned edges and the 5-minute and 1-hour windows.
  const [recent, hours, dayEdge, weekEdge, shortWindows, contractTurnover] = await Promise.all([
    fetchBlock(contract, end - HOUR, end, MINUTE),
    olderBlock(firstWeekHour, lastHour, HOUR),
    olderBlock(end - DAY, firstDayHour, MINUTE),
    olderBlock(end - WEEK, firstWeekHour, MINUTE),
    historyOnly ? [] : getRecentVolumeSeed(contract, shortAsOf)
      .then(({ trades, rates, coveredFrom }) =>
        sumShortVolume(trades, shortAsOf, rates === null ? null : new Map(rates), shortTotalOnly, coveredFrom))
      .catch(() => shortPeriods.map(({ period }) => shortTotalOnly
        ? { period, amounts: null, total: null } : { period, amounts: null })),
    contract.exchange === "okx" && contract.kind === "futures"
      ? getOkxContractTurnover(contract.id, end)
      : [],
  ]);
  const tail = { ...recent, start: lastHour };
  const history: VolumeWindow[] = [
    { period: "5m", ...sumWindow([recent], end - 5 * MINUTE, contract.onboardAt, totalOnly) },
    { period: "1h", ...sumWindow([recent], end - HOUR, contract.onboardAt, totalOnly) },
    { period: "24h", ...sumWindow([dayEdge, hours, tail], end - DAY, contract.onboardAt, totalOnly) },
    { period: "7d", ...sumWindow([weekEdge, hours, tail], end - WEEK, contract.onboardAt, totalOnly) },
  ];

  return {
    symbol: contract.id,
    asOf: end,
    shortAsOf,
    convertedFrom: contract.quote === "USDT" ? null : contract.quote,
    windows: [
      ...shortWindows,
      ...(external && historyOnly
        ? [{ period: "1m" as const, ...sumWindow([recent], end - MINUTE, contract.onboardAt, true) }]
        : []),
      ...history.map((window) => contractTurnover.find(({ period }) => period === window.period) ?? window),
    ],
  };
}

export async function getRecentVolumeSeed(
  contract: MarketInstrument,
  end = Date.now() - VOLUME_DELAY_MS,
): Promise<RecentVolumeSeed> {
  const start = end - MINUTE;
  const [data, rates] = await Promise.all([
    contract.exchange && contract.exchange !== "binance" ? getExternalRecentTrades(contract, start, end)
      : fetchAggregateTrades(contract, start, end).then((trades) => ({ trades })),
    getRecentVolumeRates(contract.quote, end),
  ]);
  return { asOf: end, ...data, rates };
}

export async function getAlertTurnover(contract: MarketInstrument, start: number, end: number) {
  start = Math.max(start, contract.onboardAt);
  if (start >= end) return 0;
  const firstMinute = Math.ceil(start / MINUTE) * MINUTE;
  const lastMinute = Math.floor(end / MINUTE) * MINUTE;
  if (firstMinute > lastMinute) {
    const trades = await fetchAggregateTrades(contract, start, end);
    return trades.reduce((total, trade) => total + trade.amount, 0);
  }
  const [middle, head, tail] = await Promise.all([
    fetchBlock(contract, firstMinute, lastMinute, MINUTE),
    start < firstMinute ? fetchAggregateTrades(contract, start, firstMinute) : [],
    lastMinute < end ? fetchAggregateTrades(contract, lastMinute, end) : [],
  ]);
  const { total } = sumWindow([middle], firstMinute, contract.onboardAt, true);
  if (total == null) return null;
  return total + [...head, ...tail].reduce((amount, trade) => amount + trade.amount, 0);
}

export async function getRecentVolumeRates(asset: string, end = Date.now()): Promise<[number, number][] | null> {
  if (asset === "USDT") return null;
  const startTime = Math.floor((end - MINUTE - VOLUME_DELAY_MS) / MINUTE) * MINUTE;
  const rates = await fetchConversionRates(asset, {
    interval: "1m",
    startTime,
    endTime: end - 1,
    limit: 3,
    maxRetriesOnFailure: 1,
  });
  return [...rates];
}

async function fetchAggregateTrades(contract: MarketInstrument, start: number, end: number): Promise<RecentTrade[]> {
  const trades: RecentTrade[] = [];
  let fromId: number | undefined;

  for (let pageIndex = 0; pageIndex < MAX_AGG_TRADE_PAGES; pageIndex++) {
    // Binance expects either the timestamp bounds or the aggregate trade ID.
    const cursor = fromId === undefined ? { startTime: start, endTime: end - 1 } : { fromId };
    const page = await getAggregateTrades(contract, { ...cursor, limit: AGG_TRADE_PAGE_SIZE });
    trades.push(...page.filter(({ T }) => T >= start && T < end)
      .map((trade) => parseAggregateTrade(trade, contract.kind === "alpha")));
    const last = page.at(-1);
    if (page.length < AGG_TRADE_PAGE_SIZE || (last && last.T >= end)) return trades;
    if (!last || !Number.isSafeInteger(last.a) || (fromId !== undefined && last.a < fromId)) {
      throw new Error("Binance aggregate trade cursor did not advance.");
    }
    fromId = last.a + 1;
  }
  throw new Error("Binance aggregate trades exceeded the page limit.");
}

async function fetchBlock(
  contract: MarketInstrument,
  start: number,
  end: number,
  step: number,
): Promise<CandleBlock> {
  const volumes: CandleBlock["volumes"] = new Map();
  if (start >= end || end <= contract.onboardAt) return { start, end, step, volumes };

  const params = {
    interval: step === HOUR ? "1h" : "1m",
    startTime: start,
    endTime: end - 1,
    limit: (end - start) / step,
    maxRetriesOnFailure: 1,
    maxRetriesOnFailureDelay: 400,
  };
  const external = contract.exchange != null && contract.exchange !== "binance";
  const totalOnly = external || contract.kind === "alpha";
  const [rows, rates] = await Promise.all([
    external ? getExternalTurnoverCandles(contract, params)
      .then((candles) => candles.map(([time, total]) => ({ time, total, buy: 0 })))
      : getKlines(contract, params).then((candles) => candles.map((row) => ({
        time: Number(row[0]), total: Number(row[7] ?? NaN), buy: totalOnly ? 0 : Number(row[10] ?? NaN),
      }))),
    contract.quote === "USDT" ? null : fetchConversionRates(contract.quote, params),
  ]);

  for (const { time, total, buy } of rows) {
    if (!Number.isFinite(total) || !Number.isFinite(buy) || total < 0 || buy < 0 || buy > total) continue;

    const rate = rates === null || total === 0 ? 1 : rates.get(time);
    if (rate === undefined) continue;
    volumes.set(time, { total: total * rate, buy: buy * rate });
  }
  return { start, end, step, volumes };
}

async function fetchConversionRates(asset: string, params: { interval: string; startTime: number; endTime: number; limit: number; maxRetriesOnFailure: number }): Promise<Map<number, number>> {
  const rates = new Map<number, number>();
  try {
    const rows = await binanceSpot.publicGetKlines({ ...params, symbol: `${asset}USDT` });
    for (const [openedAt, , , , close] of rows) {
      const rate = Number(close);
      if (Number.isFinite(rate) && rate > 0) rates.set(Number(openedAt), rate);
    }
  } catch (error) {
    if (!(error instanceof ccxt.BadSymbol)) throw error;
  }
  return rates;
}

function sumWindow(blocks: CandleBlock[], start: number, onboardAt: number, totalOnly: boolean): Omit<VolumeWindow, "period"> {
  let buy = 0;
  let sell = 0;
  let total = 0;
  for (const block of blocks) {
    const first = Math.ceil(Math.max(start, block.start) / block.step) * block.step;
    for (let time = first; time < block.end; time += block.step) {
      if (time + block.step <= onboardAt) continue;
      const volume = block.volumes.get(time);
      if (!volume) return totalOnly ? { amounts: null, total: null } : { amounts: null };
      buy += volume.buy;
      sell += volume.total - volume.buy;
      total += volume.total;
    }
  }
  return totalOnly ? { amounts: null, total } : { amounts: { buy, sell } };
}
