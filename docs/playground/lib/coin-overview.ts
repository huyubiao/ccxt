export type CoinValuation = {
  circulatingMarketCap: number | null;
  totalMarketCap: number | null;
  price: number | null;
  updatedAt: number | null;
  sourceUrl: string;
  sourceName: string;
};

export type UnlockAllocation = {
  name: string;
  amount: number | null;
  group: "insiders" | "users" | "other";
};

export type CoinUnlock = {
  symbol: string;
  time: number;
  amount: number;
  mechanism: "cliff" | "linear" | null;
  allocationComplete: boolean;
  allocations: UnlockAllocation[];
  sourceUrl: string;
  sourceName: string;
};

export function positiveNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export type CoinOverview = {
  market: CoinValuation | null;
  unlock: CoinUnlock | null;
  status: "ready" | "not-applicable" | "unmapped";
  marketError?: boolean;
  unlockError?: boolean;
};
