export const LIQUIDATION_INTERVAL_MS = 5 * 60_000;
export const LIQUIDATION_LOOKBACK_MS = 24 * 60 * 60_000;
export const LIQUIDATION_POSITION_HISTORY_MS = 3 * LIQUIDATION_LOOKBACK_MS;
export const LIQUIDATION_REFRESH_MS = 60_000;
export const LIQUIDATION_REPLACEMENT_SHARE = 0.10;
export const MARKET_CAP_DAY_MS = 24 * 60 * 60_000;
export const MARKET_CAP_WINDOWS = [360, 180, 60, 30] as const;
const leverageScenarios = [1, 2, 3, 5, 10, 20];
const liquidationModel = "open-interest-weighted-leverage";
// High-leverage scenarios represent small positions in the first margin bracket.
// Rates come from Binance's published CAKE (2024-12-19) and BTC (2025-08-19) tiers.
const highLeverageProfiles = new Map([
  ["BTCUSDT", { maintenanceRate: 0.004, mix: [[20, 0.50], [50, 0.25], [75, 0.15], [100, 0.10]] }],
  ["CAKEUSDT", { maintenanceRate: 0.01, mix: [[20, 0.75], [50, 0.20], [75, 0.05]] }],
]);
const sides = ["long", "short"] as const;
// Additional collateral as a fraction of initial margin, weighted by position quantity.
const marginScenarios = [
  { extraInitialMarginFraction: 0, long: 0.35, short: 0.15 },
  { extraInitialMarginFraction: 0.25, long: 0.25, short: 0.20 },
  { extraInitialMarginFraction: 0.50, long: 0.20, short: 0.25 },
  { extraInitialMarginFraction: 1, long: 0.15, short: 0.25 },
  { extraInitialMarginFraction: 2, long: 0.05, short: 0.15 },
] as const;
const positionAddScenario = {
  adverseDistanceFraction: 0.50,
  maxNetIncreaseFraction: 0.20,
  maxPositionIncreaseFraction: 0.25,
} as const;
// A sensitivity assumption for high-leverage cross-margin positions whose
// other losses have already eroded their buffer above maintenance margin.
const reducedMarginBuffer = { shareOfUnaugmented: 0.20, remainingDistance: 0.25 } as const;
const bandFraction = 0.005;

export type MarginBracket = { floor: number; cap: number; maxLeverage: number; rate: number; deduction: number };
export type MarginProfile = { maxLeverage: number; maintenanceRate: number; notionalCap: number; brackets?: MarginBracket[] };

type Side = typeof sides[number];
type SizeGroup = "large" | "small";
type LeverageProfile = Record<Side, Record<SizeGroup, readonly number[]>>;

// Reference allocations in percent for 2x, 3x, 5x, 10x and 20x before carving out 1x.
const baseLeverageProfile: LeverageProfile = {
  long: { large: [40, 33, 17, 7, 3], small: [20, 19, 31, 19, 11] },
  short: { large: [47, 34, 15, 3, 1], small: [27, 28, 25, 11, 9] },
};
const positionSizeMix = { large: 0.75, small: 0.25 };
const capBands = [
  { belowUsd: 20_000_000, label: "极度高风险", factor: 0.30 },
  { belowUsd: 60_000_000, label: "很高风险", factor: 0.42 },
  { belowUsd: 200_000_000, label: "高风险", factor: 0.56 },
  { belowUsd: 1_000_000_000, label: "中风险", factor: 0.67 },
  { belowUsd: 5_000_000_000, label: "低风险", factor: 0.79 },
  { belowUsd: 30_000_000_000, label: "较低风险", factor: 0.91 },
  { belowUsd: null, label: "稳定", factor: 1 },
];
const turnoverBands = [
  { above: null, label: "≤ 17.5%", factor: 1 },
  { above: 0.175, label: "> 17.5% 至 25%", factor: 0.93 },
  { above: 0.25, label: "> 25% 至 50%", factor: 0.85 },
  { above: 0.5, label: "> 50% 至 100%", factor: 0.76 },
  { above: 1, label: "> 100% 至 200%", factor: 0.66 },
  { above: 2, label: "> 200%", factor: 0.53 },
];

export type MarketCapHistory = {
  medianUsd: number;
  source: "coingecko" | "binance-cmc-proxy";
  windowDays: number;
  samples: number;
  through: number;
};

export type TurnoverInput = {
  volumeUsdt: number;
  marketCapUsd: number;
  marketCapSource?: string;
};

export function selectMarketCapHistory(
  rows: [number, number][], source: MarketCapHistory["source"], now: number, onboardAt: number,
): MarketCapHistory | null {
  const end = Math.floor(now / MARKET_CAP_DAY_MS) * MARKET_CAP_DAY_MS;
  const daily = new Map<number, { timestamp: number; cap: number }>();
  for (const [timestamp, cap] of rows) {
    if (!Number.isSafeInteger(timestamp) || timestamp > end || !Number.isFinite(cap) || cap <= 0) continue;
    const day = Math.floor(timestamp / MARKET_CAP_DAY_MS) * MARKET_CAP_DAY_MS;
    if (timestamp >= (daily.get(day)?.timestamp ?? 0)) daily.set(day, { timestamp, cap });
  }
  const through = Math.max(...daily.keys());

  function summarize(windowDays: number, values: number[]): MarketCapHistory {
    values.sort((a, b) => a - b);
    const samples = values.length;
    const medianUsd = (values[Math.floor((samples - 1) / 2)] + values[Math.floor(samples / 2)]) / 2;
    return { medianUsd, source, windowDays, samples, through };
  }

  if (through >= end - MARKET_CAP_DAY_MS) {
    for (const windowDays of MARKET_CAP_WINDOWS) {
      const start = through - (windowDays - 1) * MARKET_CAP_DAY_MS;
      const values = [...daily].filter(([day]) => day >= start).map(([, { cap }]) => cap);
      if (values.length === windowDays) return summarize(windowDays, values);
    }
  }

  if (onboardAt <= 0 || onboardAt > now || now - onboardAt >= 30 * MARKET_CAP_DAY_MS) return null;
  const sinceListing = [...daily].filter(([, { timestamp }]) => timestamp >= onboardAt);
  if (!sinceListing.length) return null;
  const windowDays = (through - Math.min(...sinceListing.map(([day]) => day))) / MARKET_CAP_DAY_MS + 1;
  return summarize(windowDays, sinceListing.map(([, { cap }]) => cap));
}

export function getLeverageWeighting(
  symbol: string, capitalization: MarketCapHistory | null = null, turnoverInput: TurnoverInput | null = null,
  marginProfile: MarginProfile | null = null,
) {
  const capIndex = capitalization
    ? capBands.findIndex(({ belowUsd }) => belowUsd === null || capitalization.medianUsd < belowUsd)
    : symbol === "BTCUSDT" || symbol === "ETHUSDT" ? capBands.length - 1 : 0;
  const marketCapBand = { ...capBands[capIndex], index: capIndex, source: capitalization ? "history" : "fallback" };
  const ratio = turnoverInput && Number.isFinite(turnoverInput.marketCapUsd) && turnoverInput.marketCapUsd > 0
    ? turnoverInput.volumeUsdt / turnoverInput.marketCapUsd : NaN;
  const turnoverIndex = Number.isFinite(ratio) && ratio >= 0
    ? turnoverBands.findLastIndex(({ above }) => above === null || ratio > above) : -1;
  const turnover = turnoverInput && turnoverIndex >= 0
    ? { ...turnoverInput, ratio, band: { ...turnoverBands[turnoverIndex], index: turnoverIndex } } : null;
  const factor = marketCapBand.factor * (turnover?.band.factor ?? 1);

  function weightsForSide(side: Side) {
    const { large, small } = baseLeverageProfile[side];
    const [base2, base3, base5, base10, base20] = large.map((value, index) =>
      (value * positionSizeMix.large + small[index] * positionSizeMix.small) / 100);
    const at5 = base5 * Math.sqrt(factor);
    const at10 = base10 * factor;
    const at20 = base20 * factor ** 2;
    const lowLeverageTotal = 1 - at5 - at10 - at20;
    const oneXShare = (side === "long" ? 0.20 : 0.30) + 0.25 * (1 - factor);
    const at1 = lowLeverageTotal * oneXShare;
    const lowLeverageScale = (lowLeverageTotal - at1) / (base2 + base3);
    return [at1, base2 * lowLeverageScale, base3 * lowLeverageScale, at5, at10, at20];
  }

  const long = weightsForSide("long");
  const short = weightsForSide("short");
  const weights = leverageScenarios.map((leverage, index) => ({
    leverage, long: long[index], short: short[index], maintenanceRate: 0,
  }));
  const fallbackProfile = highLeverageProfiles.get(symbol);
  if (marginProfile) {
    const { maxLeverage, maintenanceRate } = marginProfile;
    const high = [20, ...[50, 75, 100, 125].filter((value) => value < maxLeverage), maxLeverage];
    if (maxLeverage > 20) {
      const base = weights.pop()!;
      // Keep half of the highest baseline tier at 20x and distribute the rest
      // across supported leverage scenarios, including the actual contract limit.
      for (const [index, leverage] of high.entries()) {
        const share = index === 0 ? 0.5 : 0.5 / (high.length - 1);
        weights.push({ leverage, long: base.long * share, short: base.short * share, maintenanceRate });
      }
    }
    const supported = weights.filter(({ leverage }) => leverage < maxLeverage);
    const capped = weights.filter(({ leverage }) => leverage >= maxLeverage);
    if (capped.length) supported.push({ leverage: maxLeverage, maintenanceRate,
      long: capped.reduce((sum, weight) => sum + weight.long, 0),
      short: capped.reduce((sum, weight) => sum + weight.short, 0) });
    weights.splice(0, weights.length, ...supported.map((weight) => ({ ...weight, maintenanceRate })));
  } else if (fallbackProfile) {
    const [at20] = weights.splice(-1, 1);
    weights.push(...fallbackProfile.mix.map(([leverage, share]) => ({
      leverage, long: at20.long * share, short: at20.short * share,
      maintenanceRate: leverage > 20 ? fallbackProfile.maintenanceRate : 0,
    })));
  }
  return { capitalization, marketCapBand, turnover, factor, positionSizeMix, weights, marginProfile };
}

export type InterestPoint = { time: number; quantity: number };
export type MarkBar = { time: number; high: number; low: number; close: number; volume?: number };

export function normalizeOpenInterest(rows: { timestamp?: unknown; sumOpenInterest?: unknown }[]): InterestPoint[] {
  return rows.map((row) => ({ time: Number(row.timestamp), quantity: Number(row.sumOpenInterest) }))
    .filter(({ time, quantity }) => Number.isSafeInteger(time) && Number.isFinite(quantity) && quantity >= 0)
    .sort((a, b) => a.time - b.time);
}

export function latestOpenInterestChange(points: InterestPoint[], asOf: number) {
  const latest = points.findLast(({ time, quantity }) => time <= asOf && quantity > 0);
  if (!latest || asOf - latest.time > 2 * LIQUIDATION_INTERVAL_MS) return null;
  const previous = points.findLast(({ time, quantity }) => time === latest.time - LIQUIDATION_INTERVAL_MS && quantity > 0);
  return previous ? { time: latest.time, change: (latest.quantity / previous.quantity - 1) * 100 } : null;
}

export type LiquidationBand = {
  side: Side;
  lowerPrice: number;
  upperPrice: number;
  price: number;
  distancePercent: number;
  estimatedLiquidationUsdt: number;
  cumulativeEstimatedLiquidationUsdt: number;
  strength: number;
};

export const LIQUIDATION_SPIKE_PEAK_SHARE = 0.20;
export const LIQUIDATION_SPIKE_NEIGHBOR_MULTIPLE = 2;

export function selectLiquidationSpikes(bands: LiquidationBand[], markPrice: number, bandWidthPercent: number) {
  const width = markPrice * bandWidthPercent / 100;
  if (!Number.isFinite(width) || width <= 0) return [];
  const spikes: LiquidationBand[] = [];
  for (const side of sides) {
    const byOffset = new Map<number, LiquidationBand>();
    let peak = 0;
    for (const band of bands) {
      if (band.side !== side || band.estimatedLiquidationUsdt <= 0) continue;
      const distance = side === "long" ? markPrice - band.upperPrice : band.lowerPrice - markPrice;
      byOffset.set(Math.round(distance / width), band);
      peak = Math.max(peak, band.estimatedLiquidationUsdt);
    }

    const lastOffset = side === "long" ? Math.ceil(100 / bandWidthPercent) - 1 : Infinity;
    for (const [offset, band] of byOffset) {
      if (band.estimatedLiquidationUsdt < peak * LIQUIDATION_SPIKE_PEAK_SHARE) continue;
      let nearer = 0;
      let farther = 0;
      for (let step = 1; step <= 2; step++) {
        nearer += byOffset.get(offset - step)?.estimatedLiquidationUsdt ?? 0;
        farther += byOffset.get(offset + step)?.estimatedLiquidationUsdt ?? 0;
      }
      const nearerMean = nearer / Math.max(1, Math.min(2, offset));
      const fartherMean = farther / Math.max(1, Math.min(2, lastOffset - offset));
      // Test both directions so a flat run ending in empty bands does not look like a spike.
      if (band.estimatedLiquidationUsdt >= Math.max(nearerMean, fartherMean) * LIQUIDATION_SPIKE_NEIGHBOR_MULTIPLE) spikes.push(band);
    }
  }
  return spikes.sort((a, b) => b.estimatedLiquidationUsdt - a.estimatedLiquidationUsdt || a.lowerPrice - b.lowerPrice);
}

const tableDistanceEdges = {
  long: [0, 5, 10, 20, 30, 40, 50, 60, 70, 80],
  short: [0, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300],
};

export function groupLiquidationTable(bands: LiquidationBand[], markPrice: number, side: Side, edges: readonly number[] = tableDistanceEdges[side]) {
  const maximum = edges[edges.length - 1];
  const amounts = edges.slice(1).map(() => 0);
  for (const band of bands) {
    if (band.side !== side) continue;
    const distance = Math.abs(band.distancePercent);
    if (distance > maximum + 1e-9) continue;
    const index = amounts.findIndex((_, i) => distance < edges[i + 1] - 1e-9);
    amounts[index === -1 ? amounts.length - 1 : index] += band.estimatedLiquidationUsdt;
  }
  let cumulative = 0;
  return amounts.map((estimatedLiquidationUsdt, index) => {
    const lowerDistance = side === "long" ? -edges[index + 1] : edges[index];
    const upperDistance = side === "long" ? -edges[index] : edges[index + 1];
    cumulative += estimatedLiquidationUsdt;
    return { lowerDistance, upperDistance, lowerPrice: markPrice * (100 + lowerDistance) / 100,
      upperPrice: markPrice * (100 + upperDistance) / 100, estimatedLiquidationUsdt,
      cumulativeEstimatedLiquidationUsdt: cumulative };
  }).reverse();
}

type Cohort = { side: Side; entry: number; leverage: number; maintenanceRate: number; price: number; quantity: number; openedAt: number | null; hasAdded?: boolean };
type Weights = ReturnType<typeof getLeverageWeighting>["weights"];

function liquidationPrice(entry: number, direction: number, leverage: number, extraMargin: number, maintenanceRate: number) {
  return entry * (1 + direction * (1 + extraMargin) / leverage) / (1 + direction * maintenanceRate);
}

function bracketLiquidationPrice(entry: number, direction: number, leverage: number, extraMargin: number,
  maintenanceRate: number, profile: MarginProfile | null) {
  if (!profile?.brackets?.length) return liquidationPrice(entry, direction, leverage, extraMargin, maintenanceRate);
  const { brackets } = profile;
  // An OI cohort contains many positions. Use representative account notionals,
  // never the aggregate cohort notional, to select an exchange bracket.
  const eligible = brackets.findLast((bracket) => bracket.maxLeverage >= leverage);
  const targetNotional = profile.notionalCap * (leverage > 20 ? 0.5 : 2);
  const entryNotional = Math.min(targetNotional, (eligible?.cap ?? profile.notionalCap) * 0.95);
  for (const { floor, cap, rate, deduction } of brackets) {
    const trigger = entry * (1 + direction * ((1 + extraMargin) / leverage + deduction / entryNotional)) /
      (1 + direction * rate);
    const triggerNotional = entryNotional * trigger / entry;
    if (trigger <= 0 || (triggerNotional >= floor && triggerNotional <= cap)) return trigger;
  }
  return liquidationPrice(entry, direction, leverage, extraMargin, maintenanceRate);
}

function allocatePositionAdds(cohorts: Cohort[], side: Side, close: number, netIncrease: number, marginProfile: MarginProfile | null) {
  const direction = side === "long" ? -1 : 1;
  const candidates = [];
  let eligibleQuantity = 0;
  for (const cohort of cohorts) {
    if (cohort.side !== side || cohort.hasAdded || cohort.quantity <= 0) continue;
    const adverseMove = direction * (close - cohort.entry);
    if (adverseMove < Math.abs(cohort.price - cohort.entry) * positionAddScenario.adverseDistanceFraction) continue;
    const addedTranchePrice = bracketLiquidationPrice(close, direction, cohort.leverage, 0, cohort.maintenanceRate, marginProfile);
    if (direction * (addedTranchePrice - cohort.price) <= 0) continue;
    candidates.push({ cohort, addedTranchePrice });
    eligibleQuantity += cohort.quantity;
  }
  if (!eligibleQuantity) return netIncrease;

  const addedQuantity = Math.min(netIncrease * positionAddScenario.maxNetIncreaseFraction,
    eligibleQuantity * positionAddScenario.maxPositionIncreaseFraction);
  for (const { cohort, addedTranchePrice } of candidates) {
    const increment = addedQuantity * (cohort.quantity / eligibleQuantity);
    // With this simplified formula, pooling entry costs and margin gives a quantity-weighted liquidation price.
    cohort.price += (addedTranchePrice - cohort.price) * increment / (cohort.quantity + increment);
    cohort.quantity += increment;
    cohort.hasAdded = true;
  }
  return netIncrease - addedQuantity;
}

function openCohorts(cohorts: Cohort[], side: Side, entry: number, size: number, openedAt: number | null,
  weights: Weights, marginProfile: MarginProfile | null) {
  if (size <= 0) return;
  const direction = side === "long" ? -1 : 1;
  for (const weight of weights) {
    for (const scenario of marginScenarios) {
      const price = bracketLiquidationPrice(entry, direction, weight.leverage, scenario.extraInitialMarginFraction,
        weight.maintenanceRate, marginProfile);
      const quantity = size * weight[side] * scenario[side];
      const cohort = { side, entry, leverage: weight.leverage, maintenanceRate: weight.maintenanceRate, price, openedAt, quantity };
      if (marginProfile && weight.leverage > 20 && scenario.extraInitialMarginFraction === 0 &&
          price > 0 && direction * (price - entry) > 0) {
        const stressedQuantity = quantity * reducedMarginBuffer.shareOfUnaugmented;
        cohorts.push({ ...cohort, price: entry + (price - entry) * reducedMarginBuffer.remainingDistance,
          quantity: stressedQuantity });
        cohort.quantity -= stressedQuantity;
      }
      cohorts.push(cohort);
    }
  }
}

function initialCohorts(point: InterestPoint, priorBar: MarkBar | undefined, weights: Weights, marginProfile: MarginProfile | null) {
  const cohorts: Cohort[] = [];
  if (!priorBar || point.quantity <= 0) return cohorts;
  for (const side of sides) {
    openCohorts(cohorts, side, priorBar.low, point.quantity / 4, null, weights, marginProfile);
    openCohorts(cohorts, side, priorBar.close, point.quantity / 2, null, weights, marginProfile);
    openCohorts(cohorts, side, priorBar.high, point.quantity / 4, null, weights, marginProfile);
  }
  return cohorts.filter(({ side, price }) => side === "long" ? price < priorBar.close : price > priorBar.close);
}

function applyInterestChange(cohorts: Cohort[], previous: InterestPoint, point: InterestPoint, bar: MarkBar,
  weights: Weights, marginProfile: MarginProfile | null) {
  const change = point.quantity - previous.quantity;
  const volume = bar.volume;
  // Replacing the same quantity on both sides uses two trades per contract
  // after accounting for trades needed to produce the net OI change.
  const remainingVolume = volume !== undefined && Number.isFinite(volume) && volume >= Math.abs(change)
    ? volume - Math.abs(change) : null;
  const replacementMax = remainingVolume === null ? null
    : Math.min(previous.quantity, point.quantity, remainingVolume / 2);
  const replacedQuantity = (replacementMax ?? 0) * LIQUIDATION_REPLACEMENT_SHARE;
  const closedQuantity = Math.max(0, -change) + replacedQuantity;
  if (point.quantity === 0) cohorts.length = 0;
  else if (closedQuantity > 0) {
    const retainedFraction = 1 - closedQuantity / previous.quantity;
    for (const cohort of cohorts) cohort.quantity *= retainedFraction;
  }
  if (change > 0 || replacedQuantity > 0) {
    for (const side of sides) {
      const netNew = change > 0 ? allocatePositionAdds(cohorts, side, bar.close, change, marginProfile) : 0;
      openCohorts(cohorts, side, bar.close, netNew + replacedQuantity, point.time, weights, marginProfile);
    }
  }
  return { replacementMax, replacedQuantity };
}

function survivesBar(cohort: Cohort, bar: MarkBar) {
  return cohort.side === "long" ? bar.low > cohort.price : bar.high < cohort.price;
}

export function replayLiquidations(symbol: string, interest: InterestPoint[], bars: MarkBar[],
  warmup: number, from: number, to: number, capitalization: MarketCapHistory | null, turnover: TurnoverInput | null,
  marginProfile: MarginProfile | null = null) {
  const step = LIQUIDATION_INTERVAL_MS;
  if (warmup > from || from >= to || [warmup, from, to].some((time) => !Number.isSafeInteger(time) || time % step !== 0)) {
    throw new Error("Invalid liquidation replay window.");
  }
  const { weights } = getLeverageWeighting(symbol, capitalization, turnover, marginProfile);
  const points = new Map(interest.map((point) => [point.time, point]));
  const markBars = new Map(bars.map((bar) => [bar.time, bar]));
  const totals = { long: 0, short: 0 };
  const intervals: { time: number; low: number; high: number; openInterestChange: number; long: number; short: number;
    replacementMax: number | null; replacedQuantity: number }[] = [];
  const initial = points.get(warmup);
  let cohorts = initial ? initialCohorts(initial, markBars.get(warmup - step), weights, marginProfile) : [];
  for (let time = warmup; time < to; time += step) {
    const bar = markBars.get(time);
    const previous = points.get(time);
    const point = points.get(time + step);
    if (!bar || !previous || !point) throw new Error("A liquidation replay interval is missing.");
    const interval = { time, low: bar.low, high: bar.high, openInterestChange: point.quantity - previous.quantity, long: 0, short: 0 };
    cohorts = cohorts.filter((cohort) => {
      if (cohort.openedAt !== null && cohort.openedAt <= time - LIQUIDATION_POSITION_HISTORY_MS) return false;
      if (survivesBar(cohort, bar)) return true;
      if (time >= from) interval[cohort.side] += cohort.quantity * cohort.price;
      return false;
    });
    const replacement = applyInterestChange(cohorts, previous, point, bar, weights, marginProfile);
    if (time >= from) {
      intervals.push({ ...interval, ...replacement });
      totals.long += interval.long;
      totals.short += interval.short;
    }
  }
  return { model: liquidationModel, ...totals, total: totals.long + totals.short, capitalization, turnover, marginProfile, intervals };
}

export function estimateLiquidationLevels(
  symbol: string, interest: InterestPoint[], bars: MarkBar[], markPrice: number, asOf: number,
  capitalization: MarketCapHistory | null = null,
  turnover: TurnoverInput | null = null,
  marginProfile: MarginProfile | null = null,
) {
  const leverageWeighting = getLeverageWeighting(symbol, capitalization, turnover, marginProfile);
  const byTime = new Map(bars.map((bar) => [bar.time, bar]));
  const points = interest.filter((point) => point.time >= asOf - LIQUIDATION_POSITION_HISTORY_MS &&
    point.time <= asOf && byTime.has(point.time - LIQUIDATION_INTERVAL_MS));
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length < 2 || asOf - last.time > LIQUIDATION_INTERVAL_MS * 2) {
    throw new Error("Recent mark price and open interest data are incomplete.");
  }

  let cohorts = initialCohorts(first, byTime.get(first.time - LIQUIDATION_INTERVAL_MS), leverageWeighting.weights, marginProfile);
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const point = points[index];
    const bar = byTime.get(previous.time);
    if (!bar || point.time - previous.time !== LIQUIDATION_INTERVAL_MS) {
      throw new Error("A liquidation model input interval is missing.");
    }
    cohorts = cohorts.filter((cohort) => survivesBar(cohort, bar));
    applyInterestChange(cohorts, previous, point, bar, leverageWeighting.weights, marginProfile);
  }

  const laterBars = bars.filter((bar) => bar.time >= last.time && bar.time <= asOf);
  const low = Math.min(markPrice, ...laterBars.map((bar) => bar.low));
  const high = Math.max(markPrice, ...laterBars.map((bar) => bar.high));
  const width = markPrice * bandFraction;
  const buckets = new Map<number, { quantity: number; notional: number }>();
  const coveredQuantity = { long: 0, short: 0 };
  for (const { side, price, quantity } of cohorts) {
    if (quantity <= 0 || price <= 0 || (side === "long" ? price >= low : price <= high)) continue;
    coveredQuantity[side] += quantity;
    const bucket = Math.floor((price - markPrice) / width);
    const group = buckets.get(bucket) ?? { quantity: 0, notional: 0 };
    group.quantity += quantity;
    group.notional += quantity * price;
    buckets.set(bucket, group);
  }
  const maxNotional = Math.max(0, ...Array.from(buckets.values(), ({ notional }) => notional));
  const totals = { long: 0, short: 0 };
  const levels = Array.from(buckets)
    .sort(([a], [b]) => Math.abs(a + 0.5) - Math.abs(b + 0.5))
    .map(([bucket, { quantity, notional }]): LiquidationBand => {
      const price = notional / quantity;
      const side = bucket < 0 ? "long" : "short";
      totals[side] += notional;
      return {
        side,
        lowerPrice: Math.max(0, markPrice + bucket * width),
        upperPrice: markPrice + (bucket + 1) * width,
        price,
        distancePercent: (price / markPrice - 1) * 100,
        estimatedLiquidationUsdt: notional,
        cumulativeEstimatedLiquidationUsdt: totals[side],
        strength: notional / maxNotional * 100,
      };
    })
    .sort((a, b) => b.strength - a.strength || Math.abs(a.distancePercent) - Math.abs(b.distancePercent));

  return {
    exchange: "binance" as const, symbol, model: liquidationModel,
    amountBasis: "modeled-notional" as const, validationStatus: "uncalibrated" as const,
    asOf, markPrice, interestFrom: first.time, interestThrough: last.time,
    lookbackMs: last.time - first.time, intervalMs: LIQUIDATION_INTERVAL_MS,
    coverage: { openInterestQuantity: last.quantity, longQuantity: coveredQuantity.long, shortQuantity: coveredQuantity.short },
    bandWidthPercent: bandFraction * 100, leverageScenarios: leverageWeighting.weights.map(({ leverage }) => leverage),
    leverageWeighting, marginScenarios, positionAddScenario, reducedMarginBuffer, levels,
  };
}

export type LiquidationLevels = ReturnType<typeof estimateLiquidationLevels>;
