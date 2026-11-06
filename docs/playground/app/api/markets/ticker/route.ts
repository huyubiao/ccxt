import ccxt from "ccxt";
import { NextRequest, NextResponse } from "next/server";
import { getMarketInstrument, getMarketQuote } from "@/lib/binance-markets";
import { parseMarketExchange, parseMarketKind } from "@/lib/market-lookup";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get("symbol");
  const kind = parseMarketKind(request.nextUrl.searchParams.get("market"));
  const exchange = parseMarketExchange(request.nextUrl.searchParams.get("exchange"));

  if (!exchange || !kind || !symbol || symbol.length > 80) {
    return NextResponse.json({ error: "请从列表选择一个交易对。" }, { status: 400 });
  }

  try {
    const instrument = await getMarketInstrument(kind, symbol, exchange);
    if (!instrument) {
      return NextResponse.json({ error: "这个交易对已不在可交易列表中，请重新选择。" }, { status: 404 });
    }

    return NextResponse.json(await getMarketQuote(instrument), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ccxt.BadSymbol) {
      return NextResponse.json({ error: "这个交易对已不在可交易列表中，请重新选择。" }, { status: 404 });
    }
    if (error instanceof ccxt.RateLimitExceeded) {
      return NextResponse.json({ error: "交易所暂时限制了请求频率，请稍后重试。" }, { status: 429 });
    }
    return NextResponse.json({ error: "暂时无法取得行情，请稍后重试。" }, { status: 502 });
  }
}
