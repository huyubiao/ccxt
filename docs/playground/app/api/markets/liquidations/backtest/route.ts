import { NextRequest, NextResponse } from "next/server";
import { getMarketInstrument } from "@/lib/binance-markets";
import { getLiquidationBacktest } from "@/lib/liquidation-backtest";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get("symbol");
  if (!symbol || symbol.length > 80) return NextResponse.json({ error: "请选择币安合约。" }, { status: 400 });
  try {
    const instrument = await getMarketInstrument("futures", symbol);
    if (!instrument) return NextResponse.json({ error: "找不到该币安合约。" }, { status: 404 });
    const data = await getLiquidationBacktest(instrument);
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "清算回测暂不可用。" }, { status: 502 });
  }
}
