import { NextRequest, NextResponse } from "next/server";
import { getMarketInstrument } from "@/lib/binance-markets";
import { getSpikeForecast, getSpikeForecastOutcome } from "@/lib/binance-spike-forecast";
import { MAX_FORECAST_AGE_MS } from "@/lib/spike-forecast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const symbol = params.get("symbol");
  const settlement = params.has("settlesAt");
  const settlesAt = Number(params.get("settlesAt"));
  const time = Number(params.get("time"));
  const change = Number(params.get("change"));
  const now = Date.now();
  const validSettlement = Number.isSafeInteger(settlesAt) && settlesAt > 0 && settlesAt % 60_000 === 0;
  const validAlert = Number.isSafeInteger(time) && time >= now - MAX_FORECAST_AGE_MS && time <= now + 2000 &&
    Number.isFinite(change) && change > -100 && change !== 0;
  if (!symbol || symbol.length > 80 || (settlement ? !validSettlement : !validAlert)) {
    return NextResponse.json({ error: "无效的预测参数。" }, { status: 400 });
  }
  if (settlement && now < settlesAt + 2000) {
    return NextResponse.json({ error: "结算 K 线尚未收盘。" }, { status: 425 });
  }

  try {
    const headers = { "Cache-Control": "no-store" };
    if (settlement) {
      const outcome = await getSpikeForecastOutcome(symbol, settlesAt);
      if (!outcome && now < settlesAt + 60_000) {
        return NextResponse.json({ error: "等待交易所发布结算 K 线。" }, { status: 425 });
      }
      return NextResponse.json({ outcome }, { headers });
    }
    const pair = await getMarketInstrument("futures", symbol, "binance");
    if (!pair) return NextResponse.json({ error: "找不到此合约。" }, { status: 404 });
    return NextResponse.json(await getSpikeForecast(pair, time, change), { headers });
  } catch {
    return NextResponse.json({ error: "暂时无法取得预测行情。" }, { status: 502 });
  }
}
