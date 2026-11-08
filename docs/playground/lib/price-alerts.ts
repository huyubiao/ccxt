export const DEFAULT_ALERT_SECONDS = 60;
export const MAX_ALERT_SECONDS = 3600;

type Sample = { time: number; price: number };
export type PriceAlertState = { samples: Sample[]; baseline?: Sample };
export type DirectionalAlertState = { up: PriceAlertState; down: PriceAlertState };
export type DirectionalThresholds = { up: number | null; down: number | null };
export type AlertRatio = { ratio: number; long: number; short: number; time: number };
export type AlertMarketContext = {
  turnover: number | null;
  binanceAccounts: AlertRatio | null;
  binancePositions: AlertRatio | null;
  okxAccounts: AlertRatio | null;
  okxPositions: AlertRatio | null;
};

export function parseAlertThreshold(value: string): number | null {
  const threshold = Number(value.trim().replace(/%$/, ""));
  return Number.isFinite(threshold) && threshold > -100 && threshold !== 0 ? threshold : null;
}

export function parseAlertSeconds(value: string): number | null {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_ALERT_SECONDS ? seconds : null;
}

export function recordPrice(state: PriceAlertState, sample: Sample, threshold: number, seconds = DEFAULT_ALERT_SECONDS) {
  const { samples } = state;
  if (!Number.isFinite(sample.price) || sample.price <= 0 || !Number.isFinite(sample.time) ||
      sample.time <= (samples.at(-1)?.time ?? 0)) return null;
  const cutoff = sample.time - seconds * 1000;
  while (samples[0] && samples[0].time < cutoff) samples.shift();
  if (state.baseline && state.baseline.time <= cutoff) state.baseline = undefined;
  let reference = state.baseline ?? sample;
  if (!state.baseline) {
    for (const prior of samples) {
      if (threshold < 0 ? prior.price > reference.price : prior.price < reference.price) reference = prior;
    }
  }
  const change = (sample.price - reference.price) / reference.price * 100;
  const triggered = threshold < 0 ? change <= threshold : change >= threshold;
  if (triggered) {
    state.baseline = sample;
    samples.length = 0;
  }
  samples.push(sample);
  return { change, reference, triggered };
}

export function recordDirectionalPrice(state: DirectionalAlertState, sample: Sample, rules: DirectionalThresholds, seconds: number) {
  return (["up", "down"] as const).flatMap((direction) => {
    const threshold = rules[direction];
    if (threshold === null) return [];
    const result = recordPrice(state[direction], sample, threshold, seconds);
    return result?.triggered ? [{ ...result, threshold, direction }] : [];
  });
}
