import {
  DEFAULT_ALERT_SECONDS, DEFAULT_TURNOVER_MULTIPLE, MAX_ALERT_SECONDS, MIN_ALERT_PERCENT, MIN_ALERT_SECONDS,
  type AlertMarketContext, type DirectionalThresholds, type SpikeRecord,
} from "./price-alerts";
import type { StrategyNotificationEvent } from "./strategy-notification-events";
import type { AutoOrderRequest, AutoOrderWatch } from "./auto-order";

export type BackgroundAlert = Extract<StrategyNotificationEvent, { kind: "market-spike" }> & {
  context?: AlertMarketContext | "request-failed" | "queue-skipped";
};
export type BackgroundRule = DirectionalThresholds & {
  enabled: boolean;
  notify: boolean;
  seconds: number;
  turnoverMultiple: number;
};
export type DeliveryState = "disabled" | "queued" | "sending" | "sent" | "duplicate" |
  "rate-limited" | "failed" | "paused" | "unconfigured" | "invalid" | "config-unavailable" | "unknown";
export type BackgroundRecord = {
  id: string;
  event: BackgroundAlert;
  confirmedAt: number;
  delivery: DeliveryState;
  attempts: number;
  lastAttempt: number | null;
  lastResult: DeliveryState | null;
};
export type BackgroundMonitorStatus = {
  configured: boolean;
  rule: BackgroundRule;
  worker: "offline" | "idle" | "connecting" | "connected";
  records: BackgroundRecord[];
  spikes: SpikeRecord[];
  autoOrders: AutoOrderWatch[];
  autoOrderRequests: AutoOrderRequest[];
};

export const defaultBackgroundRule: BackgroundRule = {
  enabled: false, notify: false, up: null, down: -5,
  seconds: DEFAULT_ALERT_SECONDS, turnoverMultiple: DEFAULT_TURNOVER_MULTIPLE,
};

export function readBackgroundRule(value: unknown): BackgroundRule | null {
  if (!value || typeof value !== "object") return null;
  const { enabled, notify, up, down, seconds, turnoverMultiple } = value as Partial<BackgroundRule>;
  if (typeof enabled !== "boolean" || typeof notify !== "boolean" ||
      (up !== null && (typeof up !== "number" || !Number.isFinite(up) || up < MIN_ALERT_PERCENT)) ||
      (down !== null && (typeof down !== "number" || !Number.isFinite(down) || down <= -100 || down > -MIN_ALERT_PERCENT)) ||
      (up === null && down === null) || typeof seconds !== "number" || !Number.isInteger(seconds) ||
      seconds < MIN_ALERT_SECONDS || seconds > MAX_ALERT_SECONDS || typeof turnoverMultiple !== "number" ||
      !Number.isFinite(turnoverMultiple) || turnoverMultiple <= 1) return null;
  return { enabled, notify, up, down, seconds, turnoverMultiple };
}
