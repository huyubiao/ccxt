import ccxt from "ccxt";
import { NextRequest, NextResponse } from "next/server";
import { getMarketInstrument } from "@/lib/binance-markets";
import { getMarketVolume, getRecentVolumeRates, getRecentVolumeSeed } from "@/lib/binance-volume";
import { parseMarketExchange, parseMarketKind } from "@/lib/market-lookup";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get("symbol");
  const kind = parseMarketKind(request.nextUrl.searchParams.get("market"));
  const exchange = parseMarketExchange(request.nextUrl.searchParams.get("exchange"));
  const view = request.nextUrl.searchParams.get("view");
  if (!exchange || !kind || !symbol || symbol.length > 80) {
    return NextResponse.json({ error: "请从列表选择一个交易对。" }, { status: 400 });
  }

  try {
    const contract = await getMarketInstrument(kind, symbol, exchange);
    if (!contract) {
      return NextResponse.json({ error: "这个交易对已不在可交易列表中。" }, { status: 404 });
    }
    const volume = view === "recent" ? await getRecentVolumeSeed(contract)
      : view === "rates" ? { rates: await getRecentVolumeRates(contract.quote) }
      : await getMarketVolume(contract, view === "history");
    return NextResponse.json(volume, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ccxt.RateLimitExceeded) {
      return NextResponse.json({ error: "交易所暂时限制了请求频率，稍后会自动重试。" }, { status: 429 });
    }
    return NextResponse.json({ error: "暂时无法取得成交额，稍后会自动重试。" }, { status: 502 });
  }
}
