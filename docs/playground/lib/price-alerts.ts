export const DEFAULT_ALERT_SECONDS = 30;
export const MAX_ALERT_SECONDS = 300;
export const MIN_ALERT_PERCENT = 1;
export const DEFAULT_TURNOVER_MULTIPLE = 3;
export const TURNOVER_BASELINE_MINUTES = 60;

type Sample = { time: number; price: number };
type LevelSample = Sample & { sampledAt?: number };
export type PriceAlertState = { samples: Sample[]; baseline?: Sample };
export type DirectionalAlertState = { up: PriceAlertState; down: PriceAlertState };
export type DirectionalThresholds = { up: number | null; down: number | null };
export type PriceAlertLevel = { level: number; previous: number; target: number; sample: LevelSample; change: number };
export type PriceAlertSeries = { latest: PriceAlertLevel; confirmed: boolean };
export type LeveledPriceState = PriceAlertState & { series?: PriceAlertSeries };
export type AlertRatio = { ratio: number; long: number; short: number; time: number };
export type OkxAlertRatio =
  | { status: "ok"; data: AlertRatio }
  | { status: "no-contract" | "ambiguous-contract" | "directory-unavailable" | "no-sample" | "rate-limited" | "request-failed" };
export type AlertMarketContext = {
  turnover: number | null;
  binanceAccounts: AlertRatio | null;
  binancePositions: AlertRatio | null;
  okxAccounts: OkxAlertRatio;
  okxTopAccounts: OkxAlertRatio;
};
export type AlertTurnover = { turnover: number | null; baseline: number | null };

export function parseTurnoverMultiple(value: string): number | null {
  const multiple = Number(value);
  return Number.isFinite(multiple) && multiple > 1 ? multiple : null;
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

export function readOkxAlertRatio(rows: unknown[], time: number): OkxAlertRatio {
  let latest: AlertRatio | undefined;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const [timestamp, value] = row;
    if ((typeof timestamp !== "number" && typeof timestamp !== "string") ||
        (typeof value !== "number" && (typeof value !== "string" || !value.trim()))) continue;
    const ts = Number(timestamp);
    const ratio = Number(value);
    if (!Number.isSafeInteger(ts) || ts <= 0 || ts > time || !Number.isFinite(ratio) || ratio < 0 ||
        (latest && ts <= latest.time)) continue;
    const short = 1 / (1 + ratio);
    latest = { time: ts, ratio, long: 1 - short, short };
  }
  return latest ? { status: "ok", data: latest } : { status: "no-sample" };
}

function readSignedThreshold(value: string): number | null {
  const threshold = Number(value.trim().replace(/%$/, ""));
  return Number.isFinite(threshold) && threshold > -100 && threshold !== 0 ? threshold : null;
}

export function parseAlertThreshold(value: string): number | null {
  const threshold = readSignedThreshold(value);
  return threshold !== null && Math.abs(threshold) >= MIN_ALERT_PERCENT ? threshold : null;
}

export function restoreAlertThreshold(value: string): number | null {
  const threshold = readSignedThreshold(value);
  return threshold === null ? null : Math.sign(threshold) * Math.max(Math.abs(threshold), MIN_ALERT_PERCENT);
}

export function parseAlertSeconds(value: string): number | null {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_ALERT_SECONDS ? seconds : null;
}

export function restoreAlertSeconds(value: string): number | null {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 1 ? Math.min(seconds, MAX_ALERT_SECONDS) : null;
}

function isNewSample(samples: Sample[], sample: Sample) {
  return Number.isFinite(sample.price) && sample.price > 0 && Number.isFinite(sample.time) &&
    sample.time > (samples.at(-1)?.time ?? 0);
}

function pruneSamples(samples: Sample[], cutoff: number) {
  while (samples[0] && samples[0].time < cutoff) samples.shift();
}

export function recordPrice(state: PriceAlertState, sample: Sample, threshold: number, seconds = DEFAULT_ALERT_SECONDS) {
  const { samples } = state;
  if (!isNewSample(samples, sample)) return null;
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

function crossedLevel(start: number, startLevel: number, sample: LevelSample, threshold: number): PriceAlertLevel | null {
  const factor = 1 + threshold / 100;
  let level = startLevel;
  let target = start;
  let previous = start;
  for (;;) {
    const next = target * factor;
    if (!Number.isFinite(next) || next <= 0 || next === target) break;
    const atTarget = Math.abs(sample.price - next) <= Number.EPSILON * Math.max(sample.price, next) * 4;
    if (!atTarget && (threshold > 0 ? sample.price < next : sample.price > next)) break;
    previous = target;
    target = next;
    level++;
  }
  return level === startLevel ? null
    : { level, previous, target, sample, change: (sample.price - previous) / previous * 100 };
}

export function recordPriceLevel(state: LeveledPriceState, sample: LevelSample, threshold: number, seconds: number) {
  if (!isNewSample(state.samples, sample)) return null;
  const cutoff = sample.time - seconds * 1000;
  const series = state.series;
  if (series && series.latest.sample.time >= cutoff) {
    const move = crossedLevel(series.latest.target, series.latest.level, sample, threshold);
    pruneSamples(state.samples, cutoff);
    if (move) {
      series.latest = move;
      state.samples.length = 0;
    }
    state.samples.push(sample);
    return move && series.confirmed ? { move, series, needsTurnover: false } : null;
  }

  if (series) {
    state.series = undefined;
    state.baseline = undefined;
  }
  const result = recordPrice(state, sample, threshold, seconds);
  const move = result?.triggered ? crossedLevel(result.reference.price, 0, sample, threshold) : null;
  if (!move) return null;
  const started = { latest: move, confirmed: false };
  state.series = started;
  return { move, series: started, needsTurnover: true };
}

export function settlePriceSeries(state: LeveledPriceState, series: PriceAlertSeries, passed: boolean) {
  if (passed) {
    series.confirmed = true;
    return series.latest;
  }
  if (state.series === series) {
    state.series = undefined;
    state.baseline = undefined;
  }
  return null;
}
