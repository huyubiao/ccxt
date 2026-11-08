export type CoinValuation = {
  circulatingMarketCap: number | null;
  totalMarketCap: number | null;
  supplyLimit: "capped" | "unlimited" | "unknown";
  maxSupply: number | null;
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
  timeKind?: "scheduled" | "interval-estimate";
  periodStart?: number;
  allocations: UnlockAllocation[];
  sourceUrl: string;
  sourceName: string;
};

export type Tokenomics = {
  symbol: string;
  kind: "vesting" | "mining" | "staking" | "unknown";
  lockedAmount: number | null;
  supplyLimit: "capped" | "unlimited" | "unknown";
  maxSupply: number | null;
  percentageSupply: number | null;
  percentageBasis: "maxSupply" | "totalSupply" | null;
  events: (CoinUnlock & { timeKind: "scheduled" | "interval-estimate"; supplyPercentage: number | null })[];
  mining: {
    blockHeight: number;
    heightSourceUrl: string;
    blockReward: number;
    estimatedDailyIssuance: number;
    nextHalvingHeight: number;
    estimatedHalvingTime: number;
    nextBlockReward: number;
    nextEstimatedDailyIssuance: number;
  } | null;
  staking: {
    mechanism: "proof-of-stake";
    recipients: string;
    hasFixedHalving: false;
    hasFeeBurn: boolean;
    dailyIssuance: number | null;
    dailyBurn: number | null;
    dailyNetIssuance: number | null;
  } | null;
  sourceUrl: string;
  sourceName: string;
  updatedAt: number;
};

export function positiveNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export type CoinOverview = {
  market: CoinValuation | null;
  unlock: CoinUnlock | null;
  tokenomics: Tokenomics | null;
  status: "ready" | "not-applicable" | "unmapped";
  marketError?: boolean;
  unlockSnapshotAt?: number;
};
