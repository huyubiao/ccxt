import { NextRequest, NextResponse } from "next/server";
import { getBinanceAlertRatios } from "@/lib/binance-alert-ratios";
import { getKlines, getMarketInstrument } from "@/lib/binance-markets";
import { getAlertTurnover, getAlertTurnoverComparison } from "@/lib/binance-volume";
import { ALERT_DAY_MS, MAX_ALERT_SECONDS, MIN_ALERT_SECONDS, alertDayStart } from "@/lib/price-alerts";
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
  const validDay = time > 0 && time <= now && time === alertDayStart(time);
  const validWindow = Number.isInteger(seconds) && seconds >= minSeconds && seconds <= MAX_ALERT_SECONDS &&
    time >= now - 60 * 60 * 1000 && time <= now + 5000;
  if (!symbol || !/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,79}$/u.test(symbol) ||
      !Number.isSafeInteger(time) || !(view === "day-open" ? validDay : validWindow)) {
    return NextResponse.json({ error: "无效的告警参数。" }, { status: 400 });
  }

  try {
    if (view === "day-open") {
      const endTime = Math.min(time + ALERT_DAY_MS - 1, now);
      const candles = await getKlines({ kind: "futures", id: symbol }, {
        interval: "1h", startTime: time, endTime, limit: 24,
      });
      const first = candles.find(([start]) => Number(start) >= time && Number(start) <= endTime);
      const open = Number(first?.[1]);
      if (!Number.isFinite(open) || open <= 0) return NextResponse.json({ open: null });
      return NextResponse.json({ open }, { headers: { "Cache-Control": "private, max-age=86400" } });
    }
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
