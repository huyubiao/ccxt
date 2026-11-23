import { forecastAlertDirection, type AlertForecastDirection, type AlertVolume, type SpikeRecord } from "./price-alerts";

type MarketSpikeFields = Pick<SpikeRecord, "symbol" | "time" | "level" | "seconds" | "previous" | "price" | "change" | "threshold">;

type MarketSpikeEvent = MarketSpikeFields & {
  kind: "market-spike";
  forecastDirection: AlertForecastDirection;
  volume?: AlertVolume;
  multiple?: number | null;
};

export const MAX_TEST_NOTIFICATION_LENGTH = 500;
export type StrategyNotificationEvent = MarketSpikeEvent | { kind: "test"; text?: string };
export type NotificationConfigStatus = "ready" | "paused" | "unconfigured" | "invalid" | "config-unavailable";
export type NotificationDelivery = Exclude<NotificationConfigStatus, "ready"> | "sent" | "duplicate" | "rate-limited" | "failed";

export function createMarketSpikeEvent(
  { symbol, time, level, seconds, previous, price, change, threshold }: MarketSpikeFields,
  volume: AlertVolume, latestPrice?: number,
): MarketSpikeEvent {
  return { kind: "market-spike", symbol, time, level, seconds, previous, price, change, threshold,
    forecastDirection: forecastAlertDirection({ price, change }, latestPrice), volume };
}
