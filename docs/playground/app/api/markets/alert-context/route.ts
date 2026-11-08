import { NextRequest, NextResponse } from "next/server";
import { binanceUsdM } from "@/lib/binance-usdm";
import { findOkxPerpetual, getMarketInstrument } from "@/lib/binance-markets";
import { getAlertTurnover } from "@/lib/binance-volume";
import { getOkxAlertRatios } from "@/lib/external-markets";
import { parseAlertSeconds, type AlertMarketContext, type AlertRatio } from "@/lib/price-alerts";

export const runtime = "nodejs";

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

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const symbol = params.get("symbol");
  const seconds = parseAlertSeconds(params.get("seconds") ?? "");
  const time = Number(params.get("time"));
  const now = Date.now();
  if (!symbol || symbol.length > 80 || seconds === null || !Number.isSafeInteger(time) ||
      time < now - 60 * 60 * 1000 || time > now + 5000) {
    return NextResponse.json({ error: "无效的告警参数。" }, { status: 400 });
  }

  try {
    const contract = await getMarketInstrument("futures", symbol, "binance");
    if (!contract) return NextResponse.json({ error: "找不到此合约。" }, { status: 404 });
    const query = { symbol, period: "5m", limit: 2, endTime: time };
    const [turnover, binanceAccounts, binancePositions, okx] = await Promise.all([
      getAlertTurnover(contract, time - seconds * 1000, time + 1).catch(() => null),
      binanceUsdM.fapiDataGetGlobalLongShortAccountRatio(query)
        .then((rows) => readRatio(rows, time, "longAccount", "shortAccount")).catch(() => null),
      binanceUsdM.fapiDataGetTopLongShortPositionRatio(query)
        .then((rows) => readRatio(rows, time, "longPosition", "shortPosition")).catch(() => null),
      findOkxPerpetual(contract).catch(() => undefined)
        .then((pair) => pair ? getOkxAlertRatios(pair.id, time) : { okxAccounts: null, okxPositions: null }),
    ]);
    const context: AlertMarketContext = { turnover, binanceAccounts, binancePositions, ...okx };
    return NextResponse.json(context, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "暂时无法取得告警行情。" }, { status: 502 });
  }
}
