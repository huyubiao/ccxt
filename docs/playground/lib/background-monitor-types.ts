import type { AlertMarketContext, AlertObservationRule, DirectionalThresholds, SpikeRecord } from "./price-alerts";
import type { StrategyNotificationEvent } from "./strategy-notification-events";
import type { AutoOrderRequest, AutoOrderWatch } from "./auto-order";
import type { TradeSide } from "./trading-types";

export const defaultContinuationRule = {
  autoTrade: false, lookbackHours: 24, maxRangePercent: 5, turnoverMultiple: 5,
  stopLossPercent: 1, takeProfitPercent: 1,
};

export type ContinuationRule = typeof defaultContinuationRule;
export type ContinuationResult = {
  status: "pending" | "submitting" | "ordered" | "below-score" | "disabled" | "no-account" |
    "unavailable" | "observation-unavailable" | "breakout-lost" | "queue-skipped" | "interrupted" | "unknown" | "failed";
  score?: {
    total: number;
    pricePoints: number;
    turnoverPoints: number;
    rangePercent: number | null;
  } & ({
    breakoutPoints: number;
    flowPoints: number;
  } | {
    liquidationPoints: number;
    dominantSide: TradeSide | null;
    nearSharePercent: number | null;
  });
  side?: TradeSide;
  target?: number;
  tradeId?: string;
  error?: string;
};

export type BreakoutObservation = {
  status: "pending" | "queue-skipped" | "no-trades" | "unavailable" | "interrupted";
} | {
  status: "ready";
  windowSeconds: number;
  buyUsdt: number;
  sellUsdt: number;
  netPercent: number;
  position: "held" | "recovered" | "lost";
  targetPrice: number;
  lastPrice: number;
  lastTradeTime: number;
};

export type BackgroundAlert = Extract<StrategyNotificationEvent, { kind: "market-spike" }> & {
  context?: AlertMarketContext | "request-failed" | "queue-skipped";
  continuation?: ContinuationResult;
  breakoutObservation?: BreakoutObservation;
};
export type BackgroundRule = DirectionalThresholds & {
  enabled: boolean;
  notify: boolean;
  seconds: number;
  turnoverMultiple: number;
  observation: AlertObservationRule;
  continuation: ContinuationRule;
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
