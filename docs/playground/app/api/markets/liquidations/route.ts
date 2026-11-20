import { NextRequest, NextResponse } from "next/server";
import { getMarketInstrument } from "@/lib/binance-markets";
import { getBinanceClosedMarkBars, getBinanceLiquidationLevels } from "@/lib/binance-liquidation-levels";
import { BINANCE_MARGIN_UNAVAILABLE_MESSAGE, BinanceMarginProfileUnavailableError } from "@/lib/binance-margin-brackets";
import { LiquidationHistoryIncompleteError } from "@/lib/liquidation-levels";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get("symbol");
  const closedMarks = request.nextUrl.searchParams.get("closedMarks") === "1";
  if (!symbol || symbol.length > 80) {
    return NextResponse.json({ error: "请选择币安合约。" }, { status: 400 });
  }
  try {
    const instrument = await getMarketInstrument("futures", symbol);
    if (!instrument) return NextResponse.json({ error: "找不到该币安合约。" }, { status: 404 });
    if (closedMarks) {
      return NextResponse.json(await getBinanceClosedMarkBars(instrument.id), { headers: { "Cache-Control": "no-store" } });
    }
    const levels = await getBinanceLiquidationLevels(instrument);
    return NextResponse.json(levels, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (closedMarks) {
      return NextResponse.json({ error: "币安标记价 K 线暂不可用。" }, { status: 502 });
    }
    if (error instanceof BinanceMarginProfileUnavailableError) {
      return NextResponse.json({ error: BINANCE_MARGIN_UNAVAILABLE_MESSAGE }, { status: 503 });
    }
    if (error instanceof LiquidationHistoryIncompleteError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    return NextResponse.json({ error: "币安强平风险图暂不可用。" }, { status: 502 });
  }
}
