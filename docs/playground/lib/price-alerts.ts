export const DEFAULT_ALERT_SECONDS = 30;
export const MIN_ALERT_SECONDS = 10;
export const MAX_ALERT_SECONDS = 300;
export const MIN_ALERT_PERCENT = 2;
export const MAX_ALERT_PERCENT = 100;
export const DEFAULT_TURNOVER_MULTIPLE = 3;
export const MIN_TURNOVER_MULTIPLE = 2;
export const MAX_TURNOVER_MULTIPLE = 100;
export const TURNOVER_BASELINE_MINUTES = 60;
export const ALERT_DAY_MS = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const MAX_U32 = 0xffffffff;
export const DEFAULT_ALERT_OBSERVATION = { minutes: 15, upPercent: 3, downPercent: 3 };

type Sample = { time: number; price: number };
type LevelSample = Sample & { sampledAt?: number };
export type PriceAlertState = { samples: Sample[]; baseline?: Sample };
export type DirectionalAlertState = { up: PriceAlertState; down: PriceAlertState };
export type DirectionalThresholds = { up: number | null; down: number | null };
export type AlertObservationRule = typeof DEFAULT_ALERT_OBSERVATION;
export type PriceAlertLevel = {
  level: number; previous: number; originalReference: number; target: number;
  threshold: number; sample: LevelSample; change: number; observationMinutes?: number;
};
export type PendingPriceAlert = { move: PriceAlertLevel; highestBand: number };
type PriceAlertSeries = {
  latest: PriceAlertLevel;
  highestBand: number;
  volume: AlertVolume;
  lastAlertTime: number;
};
export type LeveledPriceState = { samples: Sample[]; latest?: Sample; pending?: PendingPriceAlert; series?: PriceAlertSeries };
export type AlertRatio = { ratio: number; long: number; short: number; time: number };
export type AlertMarketContext = {
  turnover: number | null;
  binanceAccounts: AlertRatio | null;
  binancePositions: AlertRatio | null;
};
export type AlertTurnover = { turnover: number | null; baseline: number | null };
export type AlertVolume = AlertTurnover & { multiple: number | null };
export type SpikeRecord = {
  symbol: string;
  time: number;
  price: number;
  previous: number;
  originalReference?: number;
  observationMinutes?: number;
  change: number;
  threshold: number;
  seconds: number;
  level: number;
  requiredMultiple: number | null;
  status: "pending" | "alerted" | "upgraded" | "below-threshold" | "unavailable" | "skipped" | "interrupted";
  volume?: AlertVolume;
};

export type SpikeIdentity = Pick<SpikeRecord, "symbol" | "time" | "threshold">;

export function spikeKey({ symbol, time, threshold }: SpikeIdentity) {
  return `${symbol}:${time}:${threshold}`;
}

export function alertDayStart(time: number) {
  return Math.floor((time + BEIJING_OFFSET_MS) / ALERT_DAY_MS) * ALERT_DAY_MS - BEIJING_OFFSET_MS;
}

function readAlertNumber(value: string): number | null {
  const number = Number(value);
  return value.trim() && Number.isFinite(number) ? number : null;
}

export function parseAlertObservation(minutesInput: unknown, upInput: unknown, downInput: unknown): AlertObservationRule | null {
  const read = (value: unknown) => typeof value === "string" ? readAlertNumber(value) : typeof value === "number" ? value : null;
  const minutes = read(minutesInput);
  const upPercent = read(upInput);
  const downPercent = read(downInput);
  if (minutes === null || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_U32 ||
      upPercent === null || !(upPercent > 0 && upPercent <= 100) ||
      downPercent === null || !(downPercent > 0 && downPercent <= 100)) return null;
  return { minutes, upPercent, downPercent };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function clampTurnoverMultiple(value: string): number | null {
  const multiple = readAlertNumber(value);
  return multiple === null ? null : clamp(multiple, MIN_TURNOVER_MULTIPLE, MAX_TURNOVER_MULTIPLE);
}

export function restoreTurnoverMultiple(value: string): number | null {
  return Number(value) > 1 ? clampTurnoverMultiple(value) : null;
}

export function getTurnoverBaseline(minutes: (number | undefined)[], seconds: number): number | null {
  if (minutes.length !== TURNOVER_BASELINE_MINUTES ||
      !minutes.every((amount): amount is number => amount !== undefined && Number.isFinite(amount) && amount >= 0)) return null;
  const sorted = minutes.toSorted((a, b) => a - b);
  const middle = TURNOVER_BASELINE_MINUTES / 2;
  const baseline = (sorted[middle - 1] / 2 + sorted[middle] / 2) * (seconds / 60);
  return Number.isFinite(baseline) && baseline > 0 ? baseline : null;
}

export function getTurnoverMultiple({ turnover, baseline }: AlertTurnover): number | null {
  if (turnover === null || !Number.isFinite(turnover) || turnover < 0 ||
      baseline === null || !Number.isFinite(baseline) || baseline <= 0) return null;
  const multiple = turnover / baseline;
  return Number.isFinite(multiple) ? multiple : null;
}

function readSignedThreshold(value: string): number | null {
  return readAlertNumber(value.trim().replace(/%$/, ""));
}

export function clampAlertThreshold(value: string, direction: keyof DirectionalThresholds): number | null {
  const threshold = readSignedThreshold(value);
  if (threshold === null) return null;
  return direction === "up" ? clamp(threshold, MIN_ALERT_PERCENT, MAX_ALERT_PERCENT)
    : -clamp(Math.abs(threshold), MIN_ALERT_PERCENT, MAX_ALERT_PERCENT);
}

export function restoreAlertThreshold(value: string): number | null {
  const threshold = readSignedThreshold(value);
  return threshold === null || threshold === 0 ? null
    : Math.sign(threshold) * clamp(Math.abs(threshold), MIN_ALERT_PERCENT, MAX_ALERT_PERCENT);
}

export function parseAlertSeconds(value: string): number | null {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= MIN_ALERT_SECONDS && seconds <= MAX_ALERT_SECONDS ? seconds : null;
}

export function restoreAlertSeconds(value: string): number | null {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 1 ? Math.min(MAX_ALERT_SECONDS, Math.max(MIN_ALERT_SECONDS, seconds)) : null;
}

function isNewSample(sample: Sample, previous?: Sample) {
  return Number.isFinite(sample.price) && sample.price > 0 && Number.isFinite(sample.time) &&
    sample.time > (previous?.time ?? 0);
}

function pruneSamples(samples: Sample[], cutoff: number) {
  while (samples[0] && samples[0].time < cutoff) samples.shift();
}

export function recordPrice(state: PriceAlertState, sample: Sample, threshold: number, seconds = DEFAULT_ALERT_SECONDS) {
  const { samples } = state;
  if (!isNewSample(sample, samples.at(-1))) return null;
  const cutoff = sample.time - seconds * 1000;
  pruneSamples(samples, cutoff);
  if (state.baseline && state.baseline.time <= cutoff) state.baseline = undefined;
  let reference = state.baseline ?? sample;
  if (!state.baseline) {
    for (const prior of samples) {
      if (threshold < 0 ? prior.price > reference.price : prior.price < reference.price) reference = prior;
    }
  }
  const change = (sample.price - reference.price) / reference.price * 100;
  const atThreshold = Math.abs(change - threshold) <= Number.EPSILON * Math.max(100, Math.abs(threshold));
  const triggered = atThreshold || (threshold < 0 ? change < threshold : change > threshold);
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

function firstMove(originalReference: number, sample: LevelSample, threshold: number): PriceAlertLevel | null {
  const factor = 1 + threshold / 100;
  let level = 0;
  let target = originalReference;
  let previous = originalReference;
  for (;;) {
    const next = target * factor;
    if (!Number.isFinite(next) || next <= 0 || next === target) break;
    const atTarget = Math.abs(sample.price - next) <= Number.EPSILON * Math.max(sample.price, next) * 4;
    if (!atTarget && (threshold > 0 ? sample.price < next : sample.price > next)) break;
    previous = target;
    target = next;
    level++;
  }
  return level === 0 ? null
    : { level, previous, originalReference, target, threshold, sample, change: (sample.price - previous) / previous * 100 };
}

function observationStep(threshold: number, rule: AlertObservationRule) {
  return threshold < 0 ? -rule.downPercent : rule.upPercent;
}

function reachedBand(reference: number, price: number, logStep: number) {
  if (!Number.isFinite(logStep) || logStep === 0) return 0;
  const bands = Math.log(price / reference) / logStep;
  // Absorb rounding when the price is exactly on a compounded threshold.
  const tolerance = Math.min(0.000_001, Number.EPSILON * 8 * (Math.abs(bands) + 1 / Math.abs(logStep)));
  return clamp(Math.floor(bands + tolerance), 0, MAX_U32);
}

function observationUpgrade(series: PriceAlertSeries, sample: LevelSample, rule: AlertObservationRule): PriceAlertLevel | null {
  const { originalReference } = series.latest;
  const threshold = observationStep(series.latest.threshold, rule);
  const logStep = Math.log1p(threshold / 100);
  const band = reachedBand(originalReference, sample.price, logStep);
  if (band <= series.highestBand) return null;
  const level = Math.min(MAX_U32, series.latest.level + band - series.highestBand);
  const previous = originalReference * Math.exp(logStep * (band - 1));
  const target = originalReference * Math.exp(logStep * band);
  const change = (sample.price - previous) / previous * 100;
  if (level === series.latest.level || !Number.isFinite(change) || !Number.isFinite(target) || target <= 0) return null;
  series.highestBand = band;
  return { level, previous, originalReference, target, threshold, sample, change, observationMinutes: rule.minutes };
}

function returnedToReference({ originalReference, threshold }: PriceAlertLevel, price: number) {
  return threshold > 0 ? price <= originalReference : price >= originalReference;
}

export function recordPriceLevel(state: LeveledPriceState, sample: LevelSample, rules: DirectionalThresholds, seconds: number,
  observation: AlertObservationRule = DEFAULT_ALERT_OBSERVATION) {
  const previous = state.latest;
  if (!isNewSample(sample, previous)) return null;
  state.latest = sample;
  if (state.pending) {
    if (returnedToReference(state.pending.move, sample.price)) {
      state.pending = undefined;
      state.samples.push(sample);
    }
    return null;
  }
  const series = state.series;
  if (series) {
    const elapsed = (sample.sampledAt ?? sample.time) - series.lastAlertTime;
    if (!returnedToReference(series.latest, sample.price) && elapsed < observation.minutes * 60_000) {
      if (elapsed < 0) return null;
      const move = observationUpgrade(series, sample, observation);
      if (!move) return null;
      series.latest = move;
      series.lastAlertTime = sample.sampledAt ?? sample.time;
      return { move, needsTurnover: false as const, volume: series.volume };
    }
    state.series = undefined;
    state.samples.push(sample);
    return null;
  }

  pruneSamples(state.samples, sample.time - seconds * 1000);
  const thresholds = previous && sample.price < previous.price ? [rules.down, rules.up] : [rules.up, rules.down];
  for (const threshold of thresholds) {
    if (threshold === null) continue;
    let reference = sample.price;
    for (const prior of state.samples) {
      reference = threshold > 0 ? Math.min(reference, prior.price) : Math.max(reference, prior.price);
    }
    const move = firstMove(reference, sample, threshold);
    if (!move) continue;
    const logStep = Math.log1p(observationStep(threshold, observation) / 100);
    const pending = { move, highestBand: reachedBand(reference, sample.price, logStep) };
    state.samples.length = 0;
    state.pending = pending;
    return { move, pending, needsTurnover: true as const };
  }
  state.samples.push(sample);
  return null;
}

export function settlePriceAlert(state: LeveledPriceState, pending: PendingPriceAlert,
  confirmation: { volume: AlertVolume; confirmedAt: number } | null) {
  if (state.pending !== pending) return;
  state.pending = undefined;
  if (confirmation) {
    state.series = {
      latest: pending.move, highestBand: pending.highestBand, volume: confirmation.volume, lastAlertTime: confirmation.confirmedAt,
    };
  } else if (state.latest) {
    state.samples.push(state.latest);
  }
}
