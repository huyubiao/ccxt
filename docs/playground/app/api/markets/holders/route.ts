import { NextRequest, NextResponse } from "next/server";
import { getMarketInstrument } from "@/lib/binance-markets";
import { getHolderConcentration } from "@/lib/coin-holders";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get("symbol");
  if (!symbol || !/^[A-Z0-9_]{1,80}$/.test(symbol)) {
    return NextResponse.json({ error: "请选择币安 USDT 永续合约。" }, { status: 400 });
  }
  try {
    const instrument = await getMarketInstrument("futures", symbol);
    if (!instrument) return NextResponse.json({ error: "找不到此合约。" }, { status: 404 });
    return NextResponse.json(await getHolderConcentration(instrument), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "暂时无法获取持币地址资料。" }, { status: 502 });
  }
}
