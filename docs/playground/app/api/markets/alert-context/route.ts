import { NextRequest, NextResponse } from "next/server";
import { binanceUsdM } from "@/lib/binance-usdm";
import { findOkxPerpetuals, getMarketInstrument } from "@/lib/binance-markets";
import { getAlertTurnover, getAlertTurnoverComparison } from "@/lib/binance-volume";
import { getOkxAlertRatios } from "@/lib/external-markets";
import type { MarketInstrument } from "@/lib/market-lookup";
import { parseAlertSeconds, type AlertMarketContext, type AlertRatio, type OkxAlertRatio } from "@/lib/price-alerts";
import { VOLUME_DELAY_MS } from "@/lib/short-volume";

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

async function readOkxRatios(contract: MarketInstrument, time: number) {
  const matches = await findOkxPerpetuals(contract).catch(() => null);
  if (matches?.length === 1) return getOkxAlertRatios(matches[0].id, time);
  const result: OkxAlertRatio = {
    status: matches === null ? "directory-unavailable" : matches.length ? "ambiguous-contract" : "no-contract",
  };
  return { okxAccounts: result, okxTopAccounts: result };
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const symbol = params.get("symbol");
  const view = params.get("view");
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
    if (view === "turnover") {
      // Wait for trades at the end of the window to reach the historical endpoint.
      const delay = time + VOLUME_DELAY_MS - Date.now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const data = await getAlertTurnoverComparison(contract, time + 1, seconds);
      return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
    }
    const query = { symbol, period: "5m", limit: 2, endTime: time };
    const [turnover, binanceAccounts, binancePositions, okx] = await Promise.all([
      view === "ratios" ? null : getAlertTurnover(contract, time - seconds * 1000, time + 1).catch(() => null),
      binanceUsdM.fapiDataGetGlobalLongShortAccountRatio(query)
        .then((rows) => readRatio(rows, time, "longAccount", "shortAccount")).catch(() => null),
      binanceUsdM.fapiDataGetTopLongShortPositionRatio(query)
        .then((rows) => readRatio(rows, time, "longPosition", "shortPosition")).catch(() => null),
      readOkxRatios(contract, time),
    ]);
    const context: AlertMarketContext = { turnover, binanceAccounts, binancePositions, ...okx };
    return NextResponse.json(context, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "暂时无法取得告警行情。" }, { status: 502 });
  }
}
