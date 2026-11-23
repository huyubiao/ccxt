import { binanceUsdM } from "./binance-usdm";
import type { AlertMarketContext, AlertRatio } from "./price-alerts";

type RatioRow = Record<string, unknown>;

function number(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function readRatio(rows: RatioRow[], end: number, longKey: string, shortKey: string): AlertRatio | null {
  const row = rows.findLast((item) => typeof item.timestamp === "number" && item.timestamp <= end);
  if (!row || typeof row.timestamp !== "number") return null;
  const ratio = number(row.longShortRatio);
  // The position endpoint also returns its shares under longAccount/shortAccount.
  const long = number(row[longKey] ?? row.longAccount);
  const short = number(row[shortKey] ?? row.shortAccount);
  return ratio === null || long === null || short === null ? null : { ratio, long, short, time: row.timestamp };
}

export async function getBinanceAlertRatios(symbol: string, time: number): Promise<AlertMarketContext> {
  const query = { symbol, period: "5m", limit: 2, endTime: time };
  const [binanceAccounts, binancePositions] = await Promise.all([
    binanceUsdM.fapiDataGetGlobalLongShortAccountRatio(query)
      .then((rows) => readRatio(rows, time, "longAccount", "shortAccount")).catch(() => null),
    binanceUsdM.fapiDataGetTopLongShortPositionRatio(query)
      .then((rows) => readRatio(rows, time, "longPosition", "shortPosition")).catch(() => null),
  ]);
  return { turnover: null, binanceAccounts, binancePositions };
}
