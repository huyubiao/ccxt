export const LIQUIDATION_INTERVAL_MS = 5 * 60_000;
export const LIQUIDATION_LOOKBACK_MS = 24 * 60 * 60_000;
export const LIQUIDATION_POSITION_HISTORY_MS = LIQUIDATION_LOOKBACK_MS;
export const LIQUIDATION_BACKTEST_HOURS = 24;
export const LIQUIDATION_BACKTEST_MS = LIQUIDATION_BACKTEST_HOURS * 60 * 60_000;
export const LIQUIDATION_SNAPSHOT_LEAD_MS = LIQUIDATION_INTERVAL_MS;
export const LIQUIDATION_RISK_BAND_SHARES = { elevated: 0.0025, high: 0.03, extreme: 0.06 } as const;
export const LIQUIDATION_REFRESH_MS = 60_000;
export const LIQUIDATION_DOUBLE_OPEN_CLOSE_SHARE = 0.50;
export const LIQUIDATION_LONG_TURNOVER_SHARE = 0.50;
export const positionExitScenario = {
  directionalTurnoverShare: 0.65,
  nearLiquidationDistanceFraction: 0.50,
  preferredExitShare: 0.60,
  oldStockExitShare: 0.30,
  highProfitExitShare: 0.09,
  nearLiquidationExitShare: 0.01,
} as const;
export const MARKET_CAP_DAY_MS = 24 * 60 * 60_000;
export const MARKET_CAP_WINDOWS = [360, 180, 60, 30] as const;
export const MARK_RANGE_THRESHOLDS = [0.02, 0.04, 0.07, 0.11, 0.18] as const;
export const MARK_RANGE_FACTORS = [1, 0.88, 0.53, 0.31, 0.15, 0.06] as const;
export const MARK_RANGE_MIN_COUNT = 5;
export const MARK_RANGE_WINDOW_BARS = LIQUIDATION_LOOKBACK_MS / LIQUIDATION_INTERVAL_MS;
const fallbackLeverage = 20;
const highestLeverage = 50;
const leverageScenarios = [1, 2, 3, 4, 5, 7, 10, fallbackLeverage, highestLeverage];
const liquidationModel = "open-interest-weighted-leverage";
const sides = ["long", "short"] as const;
const positionAddScenario = {
  adverseDistanceFraction: 0.50,
  maxNetIncreaseFraction: 0.20,
  maxPositionIncreaseFraction: 0.25,
} as const;
const bandFraction = 0.01;

export type MarginBracket = { floor: number; cap: number; maxLeverage: number; rate: number; deduction: number };
export type MarginProfile = {
  maxLeverage: number; maintenanceRate: number; notionalCap: number; brackets?: MarginBracket[]; fetchedAt?: number;
};

type Side = typeof sides[number];
// Baseline shares for 5x, 7x, 10x, 20x and 50x respectively.
const baseHighLeverageWeights: Record<Side, readonly number[]> = {
  long: [0.07, 0.05, 0.03, 0.009, 0.001],
  short: [0.03, 0.018, 0.01, 0.0015, 0.0005],
};
const lowLeverageRatios = { long: [35, 30, 25, 10], short: [20, 35, 25, 20] };
const capBands = [
  { belowUsd: 30_000_000, label: "极度高风险", factor: 0.07 },
  { belowUsd: 200_000_000, label: "很高风险", factor: 0.16 },
  { belowUsd: 1_000_000_000, label: "高风险", factor: 0.32 },
  { belowUsd: 4_500_000_000, label: "中风险", factor: 0.49 },
  { belowUsd: 15_000_000_000, label: "低风险", factor: 0.71 },
  { belowUsd: 45_000_000_000, label: "较稳定", factor: 0.87 },
  { belowUsd: null, label: "稳定", factor: 1 },
];
export type MarketCapHistory = {
  medianUsd: number;
  source: "coingecko" | "binance-cmc-proxy";
  windowDays: number;
  samples: number;
  through: number;
};

export type LiquidationWeightCalibration = {
  id: string;
  leveraged: readonly { leverage: number; long: number; short: number }[];
  marketCapSlope: number;
  volatilitySlope: number;
  position?: {
    lowLeverageShares: Record<Side, readonly number[]>;
    collateralMultipliers: readonly [number, number, number];
  };
};

export const BINANCE_LIQUIDATION_CALIBRATION: LiquidationWeightCalibration = {
  id: "binance-swolecharts-2026-11-19",
  marketCapSlope: 0.198,
  volatilitySlope: -0.396,
  leveraged: [
    { leverage: 10, long: 0.005698, short: 0.001495 },
    { leverage: 20, long: 0.021371, short: 0.001721 },
    { leverage: 35, long: 0.000488, short: 0 },
    { leverage: 60, long: 0.004554, short: 0.000158 },
    { leverage: 100, long: 0.003293, short: 0.001691 },
  ],
};

export const BINANCE_POSITION_CALIBRATION: LiquidationWeightCalibration = {
  id: "binance-position-calibrated-2026-11-20",
  marketCapSlope: 0.253,
  volatilitySlope: -0.361,
  leveraged: [
    { leverage: 5, long: 0.001497, short: 0.002741 },
    { leverage: 7, long: 0.00005, short: 0.00005 },
    { leverage: 10, long: 0.030976, short: 0.00005 },
    { leverage: 20, long: 0.007774, short: 0.00005 },
    { leverage: 50, long: 0.005728, short: 0.002202 },
  ],
  position: {
    lowLeverageShares: {
      long: [0.685483, 0.219727, 0.060662, 0.034128],
      short: [0.507355, 0.403601, 0.030005, 0.059039],
    },
    // Scale the buffer above maintenance for 1x-4x, >4x-10x, and >10x.
    collateralMultipliers: [1.30, 1.00, 0.70],
  },
};

export const CALIBRATION_VOLATILITY_THRESHOLDS = [0.005, 0.01, 0.02, 0.04, 0.08] as const;
const neutralCapBand = 3;

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
    const windows = source === "binance-cmc-proxy" ? [30, 7] : MARKET_CAP_WINDOWS;
    for (const windowDays of windows) {
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
  symbol: string, capitalization: MarketCapHistory | null = null, volatilityLevel: number | null = null,
  marginProfile: MarginProfile | null = null, calibration?: LiquidationWeightCalibration,
) {
  const defaultCapIndex = symbol === "BTCUSDT" || symbol === "ETHUSDT" ? capBands.length - 1 : 0;
  const neutralFallback = calibration && (!calibration.position || defaultCapIndex === 0);
  const capIndex = capitalization
    ? capBands.findIndex(({ belowUsd }) => belowUsd === null || capitalization.medianUsd < belowUsd)
    : neutralFallback ? neutralCapBand : defaultCapIndex;
  const marketCapBand = { ...capBands[capIndex], index: capIndex, source: capitalization ? "history" : "fallback" };
  if (calibration) {
    marketCapBand.factor = Math.exp(calibration.marketCapSlope * (capIndex - neutralCapBand));
    if (!capitalization) marketCapBand.label = "市值未知";
    const volatilityFactor = Math.exp(calibration.volatilitySlope * ((volatilityLevel ?? 1) - 1));
    const factor = marketCapBand.factor * volatilityFactor;
    const maintenanceRate = marginProfile?.maintenanceRate ?? 0;
    const weights = calibration.leveraged.map((tier) => ({ ...tier,
      long: tier.long * factor, short: tier.short * factor, maintenanceRate }));
    const remaining = (side: Side) => 1 - weights.reduce((sum, weight) => sum + weight[side], 0);
    const longRemainder = remaining("long");
    const shortRemainder = remaining("short");
    const lowShares = calibration.position?.lowLeverageShares;
    const lowerWeights = leverageScenarios.slice(0, 4).map((leverage, index) => ({
      leverage, maintenanceRate,
      long: longRemainder * (lowShares?.long[index] ?? lowLeverageRatios.long[index] / 100),
      short: shortRemainder * (lowShares?.short[index] ?? lowLeverageRatios.short[index] / 100),
    }));
    const ceiling = calibration.position ? modeledLeverageCeiling(marginProfile) : marginProfile?.maxLeverage ?? Infinity;
    const capped = capLeverage([...lowerWeights, ...weights], ceiling, maintenanceRate);
    const multipliers = calibration.position?.collateralMultipliers;
    return { capitalization, marketCapBand, volatilityFactor, factor,
      weights: multipliers ? capped.map((weight) => ({ ...weight, effectiveMarginRate: effectiveMarginRate(weight.leverage,
        multipliers[weight.leverage <= 4 ? 0 : weight.leverage <= 10 ? 1 : 2], marginProfile) })) : capped, marginProfile };
  }
  const volatilityFactor = MARK_RANGE_FACTORS[(volatilityLevel ?? 1) - 1] ?? MARK_RANGE_FACTORS[0];
  const factor = marketCapBand.factor * volatilityFactor;

  function weightsForSide(side: Side) {
    const lowRatios = lowLeverageRatios[side];
    const [base5, base7, base10, base20, base50] = baseHighLeverageWeights[side];
    const midLeverageFactor = Math.sqrt(factor);
    const highLeverageFactor = factor ** 2;
    const at5 = base5 * midLeverageFactor;
    const at7 = base7 * midLeverageFactor;
    const at10 = base10 * factor;
    const at20 = base20 * highLeverageFactor;
    const at50 = base50 * highLeverageFactor;
    const lowLeverageTotal = 1 - at5 - at7 - at10 - at20 - at50;
    const totalRatio = lowRatios.reduce((sum, ratio) => sum + ratio, 0);
    const lowWeights = lowRatios.map((ratio) => lowLeverageTotal * ratio / totalRatio);
    return [...lowWeights, at5, at7, at10, at20, at50];
  }

  const long = weightsForSide("long");
  const short = weightsForSide("short");
  const maintenanceRate = marginProfile?.maintenanceRate ?? 0;
  const weights = leverageScenarios.map((leverage, index) => ({
    leverage, long: long[index], short: short[index], maintenanceRate,
  }));
  return { capitalization, marketCapBand, volatilityFactor, factor,
    weights: capLeverage(weights, modeledLeverageCeiling(marginProfile), maintenanceRate), marginProfile };
}

function modeledLeverageCeiling(marginProfile: MarginProfile | null) {
  const exchangeCeiling = marginProfile?.maxLeverage ?? fallbackLeverage;
  // A missing 50x tier goes to 20x, subject to the exchange ceiling.
  return exchangeCeiling < highestLeverage ? Math.min(exchangeCeiling, fallbackLeverage) : highestLeverage;
}

type LeverageWeight = { leverage: number; long: number; short: number; maintenanceRate: number; effectiveMarginRate?: number };

function capLeverage(weights: LeverageWeight[], ceiling: number, maintenanceRate: number) {
  const capped = weights.filter(({ leverage }) => leverage > ceiling);
  if (!capped.length) return weights;
  const supported = weights.filter(({ leverage }) => leverage < ceiling);
  const merged = weights.filter(({ leverage }) => leverage >= ceiling);
  supported.push({ leverage: ceiling, maintenanceRate,
    long: merged.reduce((sum, weight) => sum + weight.long, 0),
    short: merged.reduce((sum, weight) => sum + weight.short, 0) });
  return supported;
}

export type InterestPoint = { time: number; quantity: number };
export type MarkBar = {
  time: number; open?: number; high: number; low: number; close: number; volume?: number; turnoverPrice?: number;
};

function markRange(bar: MarkBar) {
  if (bar.open === undefined || !Number.isFinite(bar.open) || bar.low <= 0 ||
      bar.open < bar.low || bar.open > bar.high) return null;
  const range = (bar.high - bar.low) / bar.open;
  return Number.isFinite(range) && range >= 0 ? range : null;
}

function rangeCountsByClose(bars: Map<number, MarkBar>, thresholds: readonly number[]) {
  const step = LIQUIDATION_INTERVAL_MS;
  const window = MARK_RANGE_WINDOW_BARS;
  const counts = thresholds.map(() => 0);
  const bands = new Array<number>(window);
  const byClose = new Map<number, number[]>();
  let consecutive = 0;
  let previousTime: number | undefined;

  for (const bar of [...bars.values()].sort((a, b) => a.time - b.time)) {
    const range = markRange(bar);
    if (range === null || bar.time % step !== 0) continue;
    if (previousTime !== bar.time - step) {
      counts.fill(0);
      consecutive = 0;
    }
    previousTime = bar.time;
    const slot = consecutive % window;
    if (consecutive >= window) {
      for (let index = 0; index <= bands[slot]; index++) counts[index]--;
    }
    // A bar above a higher threshold also contributes to each lower threshold.
    const band = thresholds.findLastIndex((threshold) => range - threshold > Number.EPSILON);
    bands[slot] = band;
    for (let index = 0; index <= band; index++) counts[index]++;
    consecutive++;
    if (consecutive >= window) byClose.set(bar.time + step, [...counts]);
  }
  return byClose;
}

function cohortWeighting(symbol: string, capitalization: MarketCapHistory | null, marginProfile: MarginProfile | null,
  bars: Map<number, MarkBar>, calibration?: LiquidationWeightCalibration) {
  const thresholds = calibration ? CALIBRATION_VOLATILITY_THRESHOLDS : MARK_RANGE_THRESHOLDS;
  const countsByClose = rangeCountsByClose(bars, thresholds);
  const profiles = MARK_RANGE_FACTORS.map((_, index) => getLeverageWeighting(symbol, capitalization, index + 1, marginProfile, calibration));
  return (time: number) => {
    const volatilityCounts = countsByClose.get(time) ?? null;
    const levelIndex = (volatilityCounts?.findLastIndex((count) => count >= MARK_RANGE_MIN_COUNT) ?? -1) + 1;
    return { ...profiles[levelIndex], volatilityLevel: levelIndex + 1, volatilityCounts, thresholds };
  };
}

export function normalizeOpenInterest(rows: { timestamp?: unknown; sumOpenInterest?: unknown }[]): InterestPoint[] {
  return rows.filter(({ sumOpenInterest }) => typeof sumOpenInterest === "number" ||
    (typeof sumOpenInterest === "string" && sumOpenInterest.trim() !== ""))
    .map((row) => ({ time: Number(row.timestamp), quantity: Number(row.sumOpenInterest) }))
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

export type LiquidationRiskBand = LiquidationBand & {
  openInterestShare: number;
  riskLevel: "low" | keyof typeof LIQUIDATION_RISK_BAND_SHARES;
};

export type LiquidationRiskSnapshot = {
  time: number;
  asOf: number;
  bands: Pick<LiquidationRiskBand, "side" | "lowerPrice" | "upperPrice" | "openInterestShare" | "riskLevel">[];
};

export const LIQUIDATION_LARGE_ZONE_PEAK_SHARE = 0.20;
export const LIQUIDATION_LARGE_ZONES_PER_SIDE = 3;
export type LiquidationZone = Pick<LiquidationBand, "side" | "lowerPrice" | "upperPrice" | "estimatedLiquidationUsdt">;

export function selectLargeLiquidationZones(bands: LiquidationBand[], markPrice: number, bandWidthPercent: number) {
  const width = markPrice * bandWidthPercent / 100;
  if (!Number.isFinite(width) || width <= 0) return [];
  const selected: LiquidationZone[] = [];
  for (const side of sides) {
    const sideBands = bands.filter((band) => band.side === side && Number.isFinite(band.estimatedLiquidationUsdt) &&
      band.estimatedLiquidationUsdt > 0 && Number.isFinite(band.lowerPrice) && Number.isFinite(band.upperPrice) &&
      band.lowerPrice >= 0 && band.upperPrice > band.lowerPrice);
    const peak = Math.max(0, ...sideBands.map((band) => band.estimatedLiquidationUsdt));
    const large = sideBands.filter((band) => band.estimatedLiquidationUsdt >= peak * LIQUIDATION_LARGE_ZONE_PEAK_SHARE)
      .sort((a, b) => a.lowerPrice - b.lowerPrice);
    const zones: LiquidationZone[] = [];
    for (const band of large) {
      const previous = zones.at(-1);
      if (previous && band.lowerPrice <= previous.upperPrice + width * 1e-6) {
        previous.upperPrice = Math.max(previous.upperPrice, band.upperPrice);
        previous.estimatedLiquidationUsdt += band.estimatedLiquidationUsdt;
      } else {
        zones.push({ side, lowerPrice: band.lowerPrice, upperPrice: band.upperPrice,
          estimatedLiquidationUsdt: band.estimatedLiquidationUsdt });
      }
    }
    zones.sort((a, b) => b.estimatedLiquidationUsdt - a.estimatedLiquidationUsdt || a.lowerPrice - b.lowerPrice);
    selected.push(...zones.slice(0, LIQUIDATION_LARGE_ZONES_PER_SIDE));
  }
  return selected.sort((a, b) => b.estimatedLiquidationUsdt - a.estimatedLiquidationUsdt || a.lowerPrice - b.lowerPrice);
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

type Cohort = {
  side: Side;
  entry: number;
  leverage: number;
  maintenanceRate: number;
  marginPerUnit: number;
  effectiveMarginRate?: number;
  accountQuantity: number;
  price: number;
  quantity: number;
  openedAt: number;
  hasAdded?: boolean;
};
type Weights = ReturnType<typeof getLeverageWeighting>["weights"];

function representativeNotional(leverage: number, profile: MarginProfile) {
  // An OI cohort contains many positions. Use representative account notionals,
  // never the aggregate cohort notional, to select an exchange bracket.
  const eligible = profile.brackets?.findLast((bracket) => bracket.maxLeverage >= leverage);
  const targetNotional = profile.notionalCap * 2;
  return Math.min(targetNotional, (eligible?.cap ?? profile.notionalCap) * 0.95);
}

function representativeQuantity(entry: number, leverage: number, profile: MarginProfile | null) {
  return profile ? representativeNotional(leverage, profile) / entry : 1;
}

function effectiveMarginRate(leverage: number, multiplier: number, profile: MarginProfile | null) {
  const initialRate = 1 / leverage;
  if (!profile || multiplier === 1 || leverage === 1) return initialRate;
  const notional = representativeNotional(leverage, profile);
  const bracket = profile.brackets?.find(({ floor, cap }) => floor <= notional && notional <= cap);
  const maintenance = bracket ? Math.max(0, bracket.rate - bracket.deduction / notional) : profile.maintenanceRate;
  const lossBuffer = Math.max(0, initialRate - maintenance);
  return Math.min(1, maintenance + multiplier * lossBuffer);
}

function positionLiquidationPrice(entry: number, direction: number, marginPerUnit: number, accountQuantity: number,
  maintenanceRate: number, profile: MarginProfile | null) {
  for (const { floor, cap, rate, deduction } of profile?.brackets ?? []) {
    const trigger = (entry + direction * (marginPerUnit + deduction / accountQuantity)) /
      (1 + direction * rate);
    const triggerNotional = accountQuantity * trigger;
    if (trigger <= 0 || (triggerNotional >= floor && triggerNotional <= cap)) return trigger;
  }
  return (entry + direction * marginPerUnit) / (1 + direction * maintenanceRate);
}

function allocatePositionAdds(cohorts: Cohort[], side: Side, close: number, netIncrease: number, marginProfile: MarginProfile | null) {
  const direction = side === "long" ? -1 : 1;
  const candidates: Cohort[] = [];
  const tranchePrices = new Map<string, number>();
  let eligibleQuantity = 0;
  for (const cohort of cohorts) {
    if (cohort.side !== side || cohort.hasAdded || cohort.quantity <= 0) continue;
    const adverseMove = direction * (close - cohort.entry);
    if (adverseMove < Math.abs(cohort.price - cohort.entry) * positionAddScenario.adverseDistanceFraction) continue;
    const key = `${cohort.leverage}:${cohort.maintenanceRate}`;
    let addedTranchePrice = tranchePrices.get(key);
    if (addedTranchePrice === undefined) {
      const accountQuantity = representativeQuantity(close, cohort.leverage, marginProfile);
      const trancheMargin = cohort.effectiveMarginRate === undefined ? close / cohort.leverage : close * cohort.effectiveMarginRate;
      addedTranchePrice = positionLiquidationPrice(close, direction, trancheMargin, accountQuantity,
        cohort.maintenanceRate, marginProfile);
      tranchePrices.set(key, addedTranchePrice);
    }
    if (direction * (addedTranchePrice - cohort.price) <= 0) continue;
    candidates.push(cohort);
    eligibleQuantity += cohort.quantity;
  }
  if (!eligibleQuantity) return netIncrease;

  const addedQuantity = Math.min(netIncrease * positionAddScenario.maxNetIncreaseFraction,
    eligibleQuantity * positionAddScenario.maxPositionIncreaseFraction);
  for (const cohort of candidates) {
    const increment = addedQuantity * (cohort.quantity / eligibleQuantity);
    const total = cohort.quantity + increment;
    const trancheMargin = cohort.effectiveMarginRate === undefined ? close / cohort.leverage : close * cohort.effectiveMarginRate;
    cohort.entry = (cohort.entry * cohort.quantity + close * increment) / total;
    cohort.marginPerUnit = (cohort.marginPerUnit * cohort.quantity + trancheMargin * increment) / total;
    cohort.accountQuantity *= total / cohort.quantity;
    cohort.quantity += increment;
    cohort.price = positionLiquidationPrice(cohort.entry, direction, cohort.marginPerUnit, cohort.accountQuantity,
      cohort.maintenanceRate, marginProfile);
    cohort.hasAdded = true;
  }
  return netIncrease - addedQuantity;
}

function openCohorts(cohorts: Cohort[], side: Side, entry: number, size: number, openedAt: number,
  weights: Weights, marginProfile: MarginProfile | null) {
  if (size <= 0) return;
  const direction = side === "long" ? -1 : 1;
  for (const weight of weights) {
    if (weight[side] <= 0) continue;
    const marginPerUnit = weight.effectiveMarginRate === undefined ? entry / weight.leverage : entry * weight.effectiveMarginRate;
    const accountQuantity = representativeQuantity(entry, weight.leverage, marginProfile);
    const price = positionLiquidationPrice(entry, direction, marginPerUnit, accountQuantity,
      weight.maintenanceRate, marginProfile);
    cohorts.push({ side, entry, leverage: weight.leverage, maintenanceRate: weight.maintenanceRate,
      marginPerUnit, effectiveMarginRate: weight.effectiveMarginRate,
      accountQuantity, price, openedAt, quantity: size * weight[side], hasAdded: false });
  }
}

type LiquidationTrace = (cohort: Readonly<Cohort>, time: number) => void;

function groupPositionExits(cohorts: Cohort[], bar: MarkBar, expiredThrough = -Infinity, onLiquidation?: LiquidationTrace) {
  const groups = {
    long: [] as Cohort[],
    short: [] as Cohort[],
    liquidated: { long: 0, short: 0 },
    liquidatedQuantity: { long: 0, short: 0 },
  };
  let kept = 0;
  for (let index = 0; index < cohorts.length; index++) {
    const cohort = cohorts[index];
    if (cohort.quantity <= 0 || cohort.openedAt <= expiredThrough) continue;
    if (!survivesBar(cohort, bar)) {
      groups.liquidated[cohort.side] += cohort.quantity * cohort.price;
      groups.liquidatedQuantity[cohort.side] += cohort.quantity;
      onLiquidation?.(cohort, bar.time);
      continue;
    }
    cohorts[kept++] = cohort;
    groups[cohort.side].push(cohort);
  }
  cohorts.length = kept;
  return groups;
}

function reduceExitGroup(cohorts: Cohort[], requested: number, unknownQuantity = 0) {
  if (requested <= 0) return { remaining: requested, unknownQuantity };
  const stock = cohorts.reduce((sum, cohort) => sum + cohort.quantity, unknownQuantity);
  const exited = Math.min(requested, stock);
  if (exited <= 0) return { remaining: requested, unknownQuantity };
  const retention = 1 - exited / stock;
  for (const cohort of cohorts) cohort.quantity *= retention;
  return { remaining: requested - exited, unknownQuantity: unknownQuantity * retention };
}

function groupByExitRank(groups: Map<number, Cohort[]>, rank: number, cohort: Cohort) {
  const matching = groups.get(rank);
  if (matching) matching.push(cohort);
  else groups.set(rank, [cohort]);
}

function closeRankedPositions(groups: Map<number, Cohort[]>, mark: number, requested: number) {
  if (requested <= 0) return 0;
  let remaining = requested;
  const distance = (cohort: Cohort) => cohort.price > 0 ? Math.abs(mark - cohort.price) : Infinity;
  for (const [, matching] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    const quantity = matching.reduce((sum, cohort) => sum + cohort.quantity, 0);
    if (quantity <= remaining) {
      for (const cohort of matching) cohort.quantity = 0;
      remaining -= quantity;
      if (remaining <= 0) return 0;
      continue;
    }
    // Only the partially filled group needs a secondary ordering by trigger distance.
    matching.sort((a, b) => {
      const first = distance(a);
      const second = distance(b);
      return first === second ? 0 : second - first;
    });
    for (const cohort of matching) {
      const exited = Math.min(cohort.quantity, remaining);
      cohort.quantity -= exited;
      remaining -= exited;
      if (remaining <= 0) return 0;
    }
    return remaining;
  }
  return remaining;
}

export function allocatePositionExits(positions: Cohort[], side: Side, mark: number, previousInterest: number,
  netExits: number, extraExits: number, exitPrice = mark) {
  const netBudget = Math.min(netExits, previousInterest);
  const extraBudget = Math.min(extraExits, previousInterest - netBudget);
  if (netBudget <= 0 && extraBudget <= 0) return;
  const direction = side === "long" ? 1 : -1;
  const near: Cohort[] = [];
  const available: Cohort[] = [];
  const profitable: Cohort[] = [];
  let trackedQuantity = 0;
  for (const cohort of positions) {
    trackedQuantity += cohort.quantity;
    const distance = direction * (mark - cohort.price);
    const approaching = direction * (mark - cohort.entry) < 0 && cohort.price > 0 && distance > 0 &&
      distance <= Math.abs(cohort.entry - cohort.price) * positionExitScenario.nearLiquidationDistanceFraction;
    if (approaching) {
      near.push(cohort);
    } else {
      available.push(cohort);
      if (netBudget > 0 && direction * (mark - cohort.entry) > 0) profitable.push(cohort);
    }
  }
  let unknownQuantity = Math.max(0, previousInterest - trackedQuantity);
  if (netBudget > 0) {
    const afterProfit = reduceExitGroup(profitable, netBudget).remaining;
    const fallback = reduceExitGroup(available, afterProfit, unknownQuantity);
    unknownQuantity = fallback.unknownQuantity;
    if (fallback.remaining > 0) reduceExitGroup(near, fallback.remaining);
  }
  if (extraBudget <= 0) return;

  const oldStockBudget = extraBudget * positionExitScenario.oldStockExitShare;
  const unidentifiedExit = Math.min(unknownQuantity, oldStockBudget);
  unknownQuantity -= unidentifiedExit;
  const oldestBudget = oldStockBudget - unidentifiedExit;
  const oldest = new Map<number, Cohort[]>();
  const preferred = new Map<number, Cohort[]>();
  const highProfit = new Map<number, Cohort[]>();
  for (const cohort of available) {
    if (cohort.quantity <= 0) continue;
    const gain = direction * (exitPrice - cohort.entry) / cohort.entry;
    groupByExitRank(preferred, Math.abs(gain), cohort);
    if (gain > 0) groupByExitRank(highProfit, -gain, cohort);
    if (oldestBudget > 0) groupByExitRank(oldest, cohort.openedAt, cohort);
  }
  const profitBudget = extraBudget * positionExitScenario.highProfitExitShare;
  const nearBudget = extraBudget * positionExitScenario.nearLiquidationExitShare;
  let preferredBudget = extraBudget * positionExitScenario.preferredExitShare;
  preferredBudget += closeRankedPositions(highProfit, mark, profitBudget);
  preferredBudget += reduceExitGroup(near, nearBudget).remaining;
  preferredBudget += closeRankedPositions(oldest, mark, oldestBudget);
  const remaining = closeRankedPositions(preferred, mark, preferredBudget) - unknownQuantity;
  if (remaining > 0) reduceExitGroup(near, remaining);
}

function splitTradeVolume(volume: number | undefined, change: number, bar: MarkBar) {
  if (volume === undefined || !Number.isFinite(volume) || volume < Math.abs(change)) return null;
  const remaining = volume - Math.abs(change);
  const pairedVolume = remaining * LIQUIDATION_DOUBLE_OPEN_CLOSE_SHARE;
  const turnover = remaining - pairedVolume;
  const open = bar.open ?? bar.close;
  let longShare = LIQUIDATION_LONG_TURNOVER_SHARE;
  if (bar.close > open) longShare = positionExitScenario.directionalTurnoverShare;
  if (bar.close < open) longShare = 1 - positionExitScenario.directionalTurnoverShare;
  const longTurnover = turnover * longShare;
  return {
    doubleOpen: Math.max(0, change) + pairedVolume / 2,
    doubleClose: Math.max(0, -change) + pairedVolume / 2,
    longTurnover,
    shortTurnover: turnover - longTurnover,
  };
}

function applyInterestChange(cohorts: Cohort[], previous: InterestPoint, point: InterestPoint, bar: MarkBar,
  weights: Weights, marginProfile: MarginProfile | null, groups: ReturnType<typeof groupPositionExits>) {
  const change = point.quantity - previous.quantity;
  const volumeBreakdown = splitTradeVolume(bar.volume, change, bar);
  if (point.quantity === 0) {
    cohorts.length = 0;
    return volumeBreakdown;
  }
  if (change === 0 && (!volumeBreakdown || bar.volume === 0)) return volumeBreakdown;

  const netIncrease = Math.max(0, change);
  const netDecrease = Math.max(0, -change);
  const baselineOldQuantity = Math.min(previous.quantity, point.quantity);
  const averageInterest = (previous.quantity + point.quantity) / 2;
  const pairedClose = volumeBreakdown ? volumeBreakdown.doubleClose - netDecrease : 0;
  const pairedExitRate = pairedClose / averageInterest;
  const remainingAfterPaired = baselineOldQuantity * Math.exp(-pairedExitRate);
  const pairedReplacement = baselineOldQuantity * -Math.expm1(-pairedExitRate);
  const turnoverPrice = bar.turnoverPrice ?? bar.close;
  for (const side of sides) {
    const positions = groups[side];
    const turnover = (side === "long" ? volumeBreakdown?.longTurnover : volumeBreakdown?.shortTurnover) ?? 0;
    const turnoverReplacement = remainingAfterPaired * -Math.expm1(-turnover / averageInterest);
    // Forced exits have already left the cohorts. Credit them against the
    // net exits first, then offsetting double closes and same-side turnover.
    const forced = groups.liquidatedQuantity[side];
    const netExits = Math.max(0, netDecrease - forced);
    const pairedExits = Math.max(0, pairedReplacement - Math.max(0, forced - netDecrease));
    const turnoverExits = Math.max(0, turnoverReplacement - Math.max(0, forced - netDecrease - pairedReplacement));
    const extraExits = pairedExits + turnoverExits;
    const exitPrice = extraExits > 0 ? bar.close + (turnoverPrice - bar.close) * (turnoverExits / extraExits) : bar.close;
    const survivingInterest = Math.max(0, previous.quantity - forced);
    allocatePositionExits(positions, side, bar.close, survivingInterest, netExits, extraExits, exitPrice);
    const netNew = netIncrease > 0 ? allocatePositionAdds(positions, side, bar.close, netIncrease, marginProfile) : 0;
    const ordinaryNew = netNew + pairedReplacement;
    if (turnoverPrice === bar.close) {
      openCohorts(cohorts, side, bar.close, ordinaryNew + turnoverReplacement, point.time, weights, marginProfile);
    } else {
      openCohorts(cohorts, side, bar.close, ordinaryNew, point.time, weights, marginProfile);
      openCohorts(cohorts, side, turnoverPrice, turnoverReplacement, point.time, weights, marginProfile);
    }
  }
  return volumeBreakdown;
}

function survivesBar(cohort: Cohort, bar: MarkBar) {
  return cohort.quantity > 0 && (cohort.side === "long" ? bar.low > cohort.price : bar.high < cohort.price);
}

export class LiquidationHistoryIncompleteError extends Error {
  constructor() {
    super("币安回看区间的未平仓量、标记价或成交量数据不完整，无法估算强平价。");
  }
}

export function requireLiquidationHistory(interest: InterestPoint[], bars: MarkBar[], from: number, to: number,
  onboardAt: number, markThrough = to) {
  const step = LIQUIDATION_INTERVAL_MS;
  const points = new Map(interest.map((point) => [point.time, point]));
  const markBars = new Map(bars.map((bar) => [bar.time, bar]));
  const listingStart = Math.ceil(onboardAt / step) * step;
  let start = from;
  if (listingStart > from) {
    // A new contract may publish its first OI snapshot after its first candle.
    start = listingStart;
    while (start < to && !points.has(start)) start += step;
  }
  if (!Number.isSafeInteger(start) || start >= to) throw new LiquidationHistoryIncompleteError();

  const window: InterestPoint[] = [];
  for (let time = start; time <= to; time += step) {
    const point = points.get(time);
    if (!point) throw new LiquidationHistoryIncompleteError();
    window.push(point);
  }
  for (let time = start; time < markThrough; time += step) {
    const bar = markBars.get(time);
    if (!bar || (time < to && (bar.volume === undefined || !Number.isFinite(bar.volume) || bar.volume < 0))) {
      throw new LiquidationHistoryIncompleteError();
    }
  }
  return window;
}

function buildLiquidationBands(cohorts: Cohort[], markPrice: number, openInterest: number,
  low = markPrice, high = markPrice, expiredThrough = -Infinity, triggers?: Record<Side, Map<number, number>>) {
  const width = markPrice * bandFraction;
  const buckets = new Map<number, { quantity: number; notional: number }>();
  const coveredQuantity = { long: 0, short: 0 };
  for (const { side, price, quantity, openedAt } of cohorts) {
    if (openedAt <= expiredThrough || quantity <= 0 || price <= 0 || (side === "long" ? price >= low : price <= high)) continue;
    coveredQuantity[side] += quantity;
    if (triggers) triggers[side].set(price, (triggers[side].get(price) ?? 0) + quantity);
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
    .map(([bucket, { quantity, notional }]): LiquidationRiskBand => {
      const price = notional / quantity;
      const side = bucket < 0 ? "long" : "short";
      const openInterestShare = openInterest > 0 ? quantity / openInterest : 0;
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
        openInterestShare,
        riskLevel: openInterestShare >= LIQUIDATION_RISK_BAND_SHARES.extreme ? "extreme"
          : openInterestShare >= LIQUIDATION_RISK_BAND_SHARES.high ? "high"
          : openInterestShare >= LIQUIDATION_RISK_BAND_SHARES.elevated ? "elevated" : "low",
      };
    })
    .sort((a, b) => b.strength - a.strength || Math.abs(a.distancePercent) - Math.abs(b.distancePercent));

  return { levels, coveredQuantity };
}

function* liquidationReplaySteps(symbol: string, interest: InterestPoint[], bars: MarkBar[],
  warmup: number, from: number, to: number, capitalization: MarketCapHistory | null,
  marginProfile: MarginProfile | null, calibration?: LiquidationWeightCalibration, onLiquidation?: LiquidationTrace,
  includeRiskSnapshots = false) {
  const step = LIQUIDATION_INTERVAL_MS;
  if (warmup > from || from >= to || [warmup, from, to].some((time) => !Number.isSafeInteger(time) || time % step !== 0)) {
    throw new Error("Invalid liquidation replay window.");
  }
  const points = new Map(interest.map((point) => [point.time, point]));
  const markBars = new Map(bars.map((bar) => [bar.time, bar]));
  const weightingAt = cohortWeighting(symbol, capitalization, marginProfile, markBars, calibration);
  const totals = { long: 0, short: 0 };
  const intervals: { time: number; low: number; high: number; openInterestChange: number; long: number; short: number;
    volumeBreakdown: ReturnType<typeof splitTradeVolume> }[] = [];
  const riskSnapshots: LiquidationRiskSnapshot[] = [];
  let cohorts: Cohort[] = [];
  for (let time = warmup; time < to; time += step) {
    const bar = markBars.get(time);
    const previous = points.get(time);
    const point = points.get(time + step);
    if (!bar || !previous || !point) throw new Error("A liquidation replay interval is missing.");
    const target = time + LIQUIDATION_SNAPSHOT_LEAD_MS;
    if (includeRiskSnapshots && target >= from && target < to) {
      const mark = markBars.get(time - step)?.close;
      if (mark && time > warmup) {
        const { levels } = buildLiquidationBands(cohorts, mark, previous.quantity, mark, mark,
          time - LIQUIDATION_POSITION_HISTORY_MS);
        const bands = levels.filter(({ riskLevel }) => riskLevel === "high" || riskLevel === "extreme")
          .map(({ side, lowerPrice, upperPrice, openInterestShare, riskLevel }) =>
            ({ side, lowerPrice, upperPrice, openInterestShare, riskLevel }));
        riskSnapshots.push({ time: target, asOf: time, bands });
      }
    }
    const interval = { time, low: bar.low, high: bar.high, openInterestChange: point.quantity - previous.quantity, long: 0, short: 0 };
    const groups = groupPositionExits(cohorts, bar, time - LIQUIDATION_POSITION_HISTORY_MS, time >= from ? onLiquidation : undefined);
    const volumeBreakdown = applyInterestChange(cohorts, previous, point, bar, weightingAt(point.time).weights, marginProfile, groups);
    if (time >= from) {
      interval.long = groups.liquidated.long;
      interval.short = groups.liquidated.short;
      intervals.push({ ...interval, volumeBreakdown });
      totals.long += interval.long;
      totals.short += interval.short;
    }
    if ((time - warmup) / step % 64 === 63) yield;
  }
  return { model: liquidationModel, calibrationId: calibration?.id ?? null,
    ...totals, total: totals.long + totals.short, capitalization, marginProfile, positionExitScenario, intervals, riskSnapshots };
}

export function replayLiquidations(symbol: string, interest: InterestPoint[], bars: MarkBar[],
  warmup: number, from: number, to: number, capitalization: MarketCapHistory | null,
  marginProfile: MarginProfile | null = null, calibration?: LiquidationWeightCalibration, onLiquidation?: LiquidationTrace) {
  const steps = liquidationReplaySteps(symbol, interest, bars, warmup, from, to, capitalization, marginProfile, calibration, onLiquidation);
  let state = steps.next();
  while (!state.done) state = steps.next();
  return state.value;
}

export async function replayLiquidationsAsync(symbol: string, interest: InterestPoint[], bars: MarkBar[],
  warmup: number, from: number, to: number, capitalization: MarketCapHistory | null,
  marginProfile: MarginProfile | null = null, calibration?: LiquidationWeightCalibration, includeRiskSnapshots = false) {
  const steps = liquidationReplaySteps(symbol, interest, bars, warmup, from, to, capitalization, marginProfile, calibration,
    undefined, includeRiskSnapshots);
  let state = steps.next();
  while (!state.done) {
    // Let pending source responses and their timeouts advance during CPU-heavy replays.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    state = steps.next();
  }
  return state.value;
}

export function estimateLiquidationLevels(
  symbol: string, interest: InterestPoint[], bars: MarkBar[], markPrice: number, asOf: number,
  capitalization: MarketCapHistory | null = null,
  marginProfile: MarginProfile | null = null, calibration?: LiquidationWeightCalibration,
) {
  const byTime = new Map(bars.map((bar) => [bar.time, bar]));
  const weightingAt = cohortWeighting(symbol, capitalization, marginProfile, byTime, calibration);
  // The data loader selects the position window. Any earlier bars only provide volatility context.
  const points = interest.filter((point) => point.time <= asOf);
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length < 2 || asOf - last.time > LIQUIDATION_INTERVAL_MS * 2) {
    throw new Error("Recent mark price and open interest data are incomplete.");
  }

  // The first OI is the comparison baseline, not an opening with a known entry price.
  let cohorts: Cohort[] = [];
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const point = points[index];
    const bar = byTime.get(previous.time);
    if (!bar || point.time - previous.time !== LIQUIDATION_INTERVAL_MS) {
      throw new Error("A liquidation model input interval is missing.");
    }
    const groups = groupPositionExits(cohorts, bar);
    applyInterestChange(cohorts, previous, point, bar, weightingAt(point.time).weights, marginProfile, groups);
  }

  const laterBars = bars.filter((bar) => bar.time >= last.time && bar.time <= asOf);
  const low = Math.min(markPrice, ...laterBars.map((bar) => bar.low));
  const high = Math.max(markPrice, ...laterBars.map((bar) => bar.high));
  const triggers = { long: new Map<number, number>(), short: new Map<number, number>() };
  const { levels, coveredQuantity } = buildLiquidationBands(cohorts, markPrice, last.quantity, low, high, -Infinity, triggers);

  const currentClose = Math.floor(asOf / LIQUIDATION_INTERVAL_MS) * LIQUIDATION_INTERVAL_MS;
  const leverageWeighting = weightingAt(currentClose);
  return {
    exchange: "binance" as const, symbol, model: liquidationModel, calibrationId: calibration?.id ?? null,
    amountBasis: "modeled-notional" as const, validationStatus: calibration ? "reference-calibrated" as const : "uncalibrated" as const,
    asOf, markPrice, interestFrom: first.time, interestThrough: last.time,
    lookbackMs: last.time - first.time, intervalMs: LIQUIDATION_INTERVAL_MS,
    coverage: { openInterestQuantity: last.quantity, longQuantity: coveredQuantity.long, shortQuantity: coveredQuantity.short },
    bandWidthPercent: bandFraction * 100, leverageScenarios: leverageWeighting.weights.map(({ leverage }) => leverage),
    leverageWeighting, positionAddScenario, positionExitScenario, levels,
    triggers: { long: Array.from(triggers.long), short: Array.from(triggers.short) },
  };
}

export type LiquidationLevels = ReturnType<typeof estimateLiquidationLevels>;
