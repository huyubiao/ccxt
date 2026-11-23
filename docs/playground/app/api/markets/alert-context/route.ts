import { NextRequest, NextResponse } from "next/server";
import { getBinanceAlertRatios } from "@/lib/binance-alert-ratios";
import { getMarketInstrument } from "@/lib/binance-markets";
import { getAlertTurnover, getAlertTurnoverComparison } from "@/lib/binance-volume";
import { MAX_ALERT_SECONDS, MIN_ALERT_SECONDS } from "@/lib/price-alerts";
import { VOLUME_DELAY_MS } from "@/lib/short-volume";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const symbol = params.get("symbol");
  const view = params.get("view");
  // Previously recorded alerts retain the window that was used at the time.
  const seconds = Number(params.get("seconds"));
  const minSeconds = view === "turnover" ? MIN_ALERT_SECONDS : 1;
  const time = Number(params.get("time"));
  const now = Date.now();
  if (!symbol || symbol.length > 80 || !Number.isInteger(seconds) || seconds < minSeconds || seconds > MAX_ALERT_SECONDS ||
      !Number.isSafeInteger(time) ||
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
    const [turnover, ratios] = await Promise.all([
      view === "ratios" ? null : getAlertTurnover(contract, time - seconds * 1000, time + 1).catch(() => null),
      getBinanceAlertRatios(symbol, time),
    ]);
    return NextResponse.json({ ...ratios, turnover }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "暂时无法取得告警行情。" }, { status: 502 });
  }
}
