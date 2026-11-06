import { NextRequest, NextResponse } from "next/server";
import { getMarketDirectory } from "@/lib/binance-markets";
import { parseMarketExchange } from "@/lib/market-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const exchange = parseMarketExchange(request.nextUrl.searchParams.get("exchange"));
  if (!exchange) return NextResponse.json({ error: "未知的交易平台。" }, { status: 400 });
  return NextResponse.json(await getMarketDirectory(exchange), { headers: { "Cache-Control": "no-store" } });
}
