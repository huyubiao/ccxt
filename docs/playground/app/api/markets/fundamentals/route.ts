import { NextRequest, NextResponse } from "next/server";
import { getMarketInstrument } from "@/lib/binance-markets";
import { getCoinOverview } from "@/lib/coin-fundamentals";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get("symbol");
  if (!symbol || symbol.length > 80) {
    return NextResponse.json({ error: "请选择币安合约。" }, { status: 400 });
  }
  try {
    const instrument = await getMarketInstrument("futures", symbol);
    if (!instrument) return NextResponse.json({ error: "该合约已不在目录中。" }, { status: 404 });
    return NextResponse.json(await getCoinOverview(instrument), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "币种资料暂时无法同步。" }, { status: 502 });
  }
}
