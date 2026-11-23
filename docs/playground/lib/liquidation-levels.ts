export const LIQUIDATION_INTERVAL_MS = 5 * 60_000;
export const LIQUIDATION_RISK_BAND_SHARES = { elevated: 0.0025, high: 0.03, extreme: 0.06 } as const;
export const LIQUIDATION_REFRESH_MS = 60_000;
export const MARK_RANGE_MIN_COUNT = 5;

type Side = "long" | "short";

export type LiquidationRiskBand = {
  side: Side;
  lowerPrice: number;
  upperPrice: number;
  price: number;
  distancePercent: number;
  estimatedLiquidationUsdt: number;
  cumulativeEstimatedLiquidationUsdt: number;
  strength: number;
  openInterestShare: number;
  riskLevel: "low" | keyof typeof LIQUIDATION_RISK_BAND_SHARES;
};

export type LiquidationLevels = {
  asOf: number;
  markPrice: number;
  interestThrough: number;
  lookbackMs: number;
  coverage: { openInterestQuantity: number; longQuantity: number; shortQuantity: number };
  bandWidthPercent: number;
  leverageWeighting: {
    capitalization: { windowDays: number; medianUsd: number } | null;
    marketCapBand: { label: string; factor: number };
    volatilityLevel: number;
    volatilityFactor: number;
    volatilityCounts: number[] | null;
    thresholds: number[];
    factor: number;
    weights: { leverage: number; effectiveMarginRate?: number; long: number; short: number }[];
  };
  positionExitScenario: {
    directionalTurnoverShare: number;
    preferredExitShare: number;
    oldStockExitShare: number;
    highProfitExitShare: number;
    nearLiquidationExitShare: number;
  };
  levels: LiquidationRiskBand[];
  triggers: Record<Side, [price: number, estimatedNotional: number][]>;
};
