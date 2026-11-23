import type { AlertMarketContext, DirectionalThresholds, SpikeRecord } from "./price-alerts";
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
