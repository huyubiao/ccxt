import type { StrategyNotification } from "@/lib/strategy-notifications";

type MarketSpikeEvent = {
  kind: "market-spike";
  symbol: string;
  time: number;
  level: number;
  seconds: number;
  previous: number;
  price: number;
  change: number;
  threshold: number;
  multiple?: number | null;
};

export const MAX_TEST_NOTIFICATION_LENGTH = 500;
export type StrategyNotificationEvent = MarketSpikeEvent | { kind: "test"; text?: string };

const formatTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium", hourCycle: "h23",
});
const formatPrice = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 12 });
const formatPercent = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4, signDisplay: "exceptZero" });
const formatMultiple = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

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

  const { symbol, time, level, seconds, previous, price, change, threshold, multiple } = input as Partial<MarketSpikeEvent>;
  if (typeof symbol !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,79}$/u.test(symbol) ||
      !positiveInteger(time) || time > 8.64e15 || !positiveInteger(level) || !positiveInteger(seconds) ||
      !finiteNumber(previous) || previous <= 0 || !finiteNumber(price) || price <= 0 ||
      !finiteNumber(change) || !finiteNumber(threshold) || threshold === 0 ||
      Math.sign(change) !== Math.sign(threshold) || (multiple != null && (!finiteNumber(multiple) || multiple < 0))) return null;

  const lines = [
    `${formatTime.format(time)}（北京时间）`,
    `${seconds} 秒窗口 · 涨跌 ${formatPercent.format(change)}% · 阈值 ${formatPercent.format(threshold)}%`,
    `参考价 ${formatPrice.format(previous)} → 触发价 ${formatPrice.format(price)} USDT`,
  ];
  if (multiple != null) lines.push(`成交额 ${formatMultiple.format(multiple)} 倍`);
  return {
    title: `异动监控｜${symbol} ${level} 级告警`,
    lines,
    deduplicationKey: `market-spike:${symbol}:${time}:${seconds}:${threshold}:${level}`,
  };
}
