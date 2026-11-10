import { NextRequest, NextResponse } from "next/server";
import { getMarketInstrument } from "@/lib/binance-markets";
import { getMarketFundingRates } from "@/lib/market-funding";
import { parseMarketExchange } from "@/lib/market-lookup";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get("symbol");
  const exchange = parseMarketExchange(request.nextUrl.searchParams.get("exchange"));
  if (!exchange || !symbol || symbol.length > 80) return NextResponse.json({ error: "请选择永续合约。" }, { status: 400 });
  try {
    const pair = await getMarketInstrument("futures", symbol, exchange);
    if (!pair) return NextResponse.json({ error: "找不到该永续合约。" }, { status: 404 });
    return NextResponse.json(await getMarketFundingRates(pair), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "资金费率暂不可用。" }, { status: 502 });
  }
}
