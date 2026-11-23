import type { StrategyNotification } from "@/lib/strategy-notifications";
import { formatAlertTurnover } from "./market-number";
import { alertForecastLabels, forecastAlertDirection, type AlertForecastDirection, type AlertVolume, type SpikeRecord } from "./price-alerts";

type MarketSpikeFields = Pick<SpikeRecord, "symbol" | "time" | "level" | "seconds" | "previous" | "price" | "change" | "threshold">;

type MarketSpikeEvent = MarketSpikeFields & {
  kind: "market-spike";
  forecastDirection: AlertForecastDirection;
  volume?: AlertVolume;
  multiple?: number | null;
};

export const MAX_TEST_NOTIFICATION_LENGTH = 500;
export type StrategyNotificationEvent = MarketSpikeEvent | { kind: "test"; text?: string };

const formatTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium", hourCycle: "h23",
});
const formatPrice = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 12 });
const formatPercent = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4, signDisplay: "exceptZero" });

export function createMarketSpikeEvent(
  { symbol, time, level, seconds, previous, price, change, threshold }: MarketSpikeFields,
  volume: AlertVolume, latestPrice?: number,
): MarketSpikeEvent {
  return { kind: "market-spike", symbol, time, level, seconds, previous, price, change, threshold,
    forecastDirection: forecastAlertDirection({ price, change }, latestPrice), volume };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
  return finiteNumber(value) && Number.isSafeInteger(value) && value > 0;
}

export function formatNotificationEvent(input: unknown): StrategyNotification | null {
  if (!input || typeof input !== "object" || !("kind" in input)) return null;
  if (input.kind === "test") {
    const text = "text" in input ? input.text : undefined;
    if (text !== undefined && (typeof text !== "string" || text.length > MAX_TEST_NOTIFICATION_LENGTH)) return null;
    return { title: "钉钉推送测试", lines: [text?.trim() || "交易策略通知已连通。"] };
  }
  if (input.kind !== "market-spike") return null;

  const { symbol, time, level, seconds, previous, price, change, threshold, forecastDirection, volume, multiple } = input as Partial<MarketSpikeEvent>;
  if (typeof symbol !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,79}$/u.test(symbol) ||
      !positiveInteger(time) || time > 8.64e15 || !positiveInteger(level) || !positiveInteger(seconds) ||
      !finiteNumber(previous) || previous <= 0 || !finiteNumber(price) || price <= 0 ||
      !finiteNumber(change) || !finiteNumber(threshold) || threshold === 0 ||
      Math.sign(change) !== Math.sign(threshold) || (multiple != null && (!finiteNumber(multiple) || multiple < 0)) ||
      (forecastDirection != null && forecastDirection !== "up" && forecastDirection !== "down")) return null;

  const lines = [
    `${formatTime.format(time)}（北京时间）`,
    `${seconds} 秒窗口 · 涨跌 ${formatPercent.format(change)}% · 阈值 ${formatPercent.format(threshold)}%`,
    `参考价 ${formatPrice.format(previous)} → 触发价 ${formatPrice.format(price)} USDT`,
  ];
  const turnover = formatAlertTurnover(volume, multiple);
  if (turnover) lines.push(turnover);
  const direction = forecastDirection ?? forecastAlertDirection({ price, change });
  lines.push(`涨跌预测：${alertForecastLabels[direction]}`);
  return {
    title: `异动监控｜${symbol} ${level} 级告警`,
    lines,
    deduplicationKey: `market-spike:${symbol}:${time}:${seconds}:${threshold}:${level}`,
  };
}
