export const LIQUIDATION_INTERVAL_MS = 5 * 60_000;
export const LIQUIDATION_LOOKBACK_MS = 24 * 60 * 60_000;
export const LIQUIDATION_REFRESH_MS = 30_000;
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
const bandFraction = 0.005;

export type MarginProfile = { maxLeverage: number; maintenanceRate: number; notionalCap: number };

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
export type MarkBar = { time: number; high: number; low: number; close: number };

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

const tableDistanceEdges = {
  long: [0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95],
  short: [0, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000],
};

export function groupLiquidationTable(bands: LiquidationBand[], markPrice: number, side: Side) {
  const edges = tableDistanceEdges[side];
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

type Cohort = { side: Side; entry: number; leverage: number; maintenanceRate: number; price: number; quantity: number; openedAt: number; hasAdded?: boolean };

function liquidationPrice(entry: number, direction: number, leverage: number, extraMargin: number, maintenanceRate: number) {
  return entry * (1 + direction * (1 + extraMargin) / leverage) / (1 + direction * maintenanceRate);
}

function allocatePositionAdds(cohorts: Cohort[], side: Side, close: number, netIncrease: number) {
  const direction = side === "long" ? -1 : 1;
  const candidates = [];
  let eligibleQuantity = 0;
  for (const cohort of cohorts) {
    if (cohort.side !== side || cohort.hasAdded || cohort.quantity <= 0) continue;
    const adverseMove = direction * (close - cohort.entry);
    if (adverseMove < Math.abs(cohort.price - cohort.entry) * positionAddScenario.adverseDistanceFraction) continue;
    const addedTranchePrice = liquidationPrice(close, direction, cohort.leverage, 0, cohort.maintenanceRate);
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

function applyInterestChange(cohorts: Cohort[], previous: InterestPoint, point: InterestPoint, bar: MarkBar,
  weights: ReturnType<typeof getLeverageWeighting>["weights"]) {
  const change = point.quantity - previous.quantity;
  if (change < 0) {
    const retainedFraction = point.quantity / previous.quantity;
    for (const cohort of cohorts) cohort.quantity *= retainedFraction;
  } else if (change > 0) {
    for (const side of sides) {
      const direction = side === "long" ? -1 : 1;
      const newQuantity = allocatePositionAdds(cohorts, side, bar.close, change);
      for (const weight of weights) {
        for (const scenario of marginScenarios) {
          const price = liquidationPrice(bar.close, direction, weight.leverage, scenario.extraInitialMarginFraction, weight.maintenanceRate);
          cohorts.push({ side, entry: bar.close, leverage: weight.leverage, maintenanceRate: weight.maintenanceRate, price, openedAt: point.time,
            quantity: newQuantity * weight[side] * scenario[side] });
        }
      }
    }
  }
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
  let cohorts: Cohort[] = [];
  for (let time = warmup; time < to; time += step) {
    const bar = markBars.get(time);
    const previous = points.get(time);
    const point = points.get(time + step);
    if (!bar || !previous || !point) throw new Error("A liquidation replay interval is missing.");
    cohorts = cohorts.filter((cohort) => {
      if (cohort.openedAt <= time - LIQUIDATION_LOOKBACK_MS) return false;
      if (survivesBar(cohort, bar)) return true;
      if (time >= from) totals[cohort.side] += cohort.quantity * cohort.price;
      return false;
    });
    applyInterestChange(cohorts, previous, point, bar, weights);
  }
  return { model: liquidationModel, ...totals, total: totals.long + totals.short, capitalization, turnover, marginProfile };
}

export function estimateLiquidationLevels(
  symbol: string, interest: InterestPoint[], bars: MarkBar[], markPrice: number, asOf: number,
  capitalization: MarketCapHistory | null = null,
  turnover: TurnoverInput | null = null,
  marginProfile: MarginProfile | null = null,
) {
  const leverageWeighting = getLeverageWeighting(symbol, capitalization, turnover, marginProfile);
  const byTime = new Map(bars.map((bar) => [bar.time, bar]));
  const points = interest.filter((point) => point.time >= asOf - LIQUIDATION_LOOKBACK_MS &&
    point.time <= asOf && byTime.has(point.time - LIQUIDATION_INTERVAL_MS));
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length < 2 || asOf - last.time > LIQUIDATION_INTERVAL_MS * 2) {
    throw new Error("Recent mark price and open interest data are incomplete.");
  }

  let cohorts: Cohort[] = [];
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const point = points[index];
    const bar = byTime.get(previous.time);
    if (!bar || point.time - previous.time !== LIQUIDATION_INTERVAL_MS) {
      throw new Error("A liquidation model input interval is missing.");
    }
    cohorts = cohorts.filter((cohort) => survivesBar(cohort, bar));
    applyInterestChange(cohorts, previous, point, bar, leverageWeighting.weights);
  }

  const laterBars = bars.filter((bar) => bar.time >= last.time && bar.time <= asOf);
  const low = Math.min(markPrice, ...laterBars.map((bar) => bar.low));
  const high = Math.max(markPrice, ...laterBars.map((bar) => bar.high));
  const width = markPrice * bandFraction;
  const buckets = new Map<number, { quantity: number; notional: number }>();
  for (const { side, price, quantity } of cohorts) {
    if (quantity <= 0 || price <= 0 || (side === "long" ? price >= low : price <= high)) continue;
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
    lookbackMs: LIQUIDATION_LOOKBACK_MS, intervalMs: LIQUIDATION_INTERVAL_MS,
    bandWidthPercent: bandFraction * 100, leverageScenarios: leverageWeighting.weights.map(({ leverage }) => leverage),
    leverageWeighting, marginScenarios, positionAddScenario, levels,
  };
}

export type LiquidationLevels = ReturnType<typeof estimateLiquidationLevels>;
