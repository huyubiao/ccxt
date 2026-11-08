import snapshot from "./coin-unlock-snapshot.json" with { type: "json" };
import issuanceRules from "./coin-issuance-rules.json" with { type: "json" };
import stakingRules from "./coin-staking-rules.json" with { type: "json" };
import type { CoinUnlock, Tokenomics } from "./coin-overview";

type StoredToken = CoinUnlock & {
  events?: CoinUnlock[];
  lockedAmount?: number | null;
  maxSupply?: number | null;
  supplyLimit?: Tokenomics["supplyLimit"];
  percentageSupply?: number | null;
  percentageBasis?: Tokenomics["percentageBasis"];
  geckoId?: string;
  updatedAt?: number;
};
const stored = snapshot as unknown as {
  generatedAt: number;
  contracts: Record<string, StoredToken>;
  blockHeights?: Record<string, { height: number; time: number; sourceUrl: string }>;
};
const contracts = stored.contracts;
export const unlockSnapshotAt = snapshot.generatedAt;

export function getNextUnlock(contract: string, now = Date.now()): CoinUnlock | null {
  return getTokenomics(contract, now).events[0] ?? null;
}

export function getStoredIdentity(contract: string) {
  return contracts[contract]?.geckoId;
}

export function getTokenomics(contract: string, now = Date.now()): Tokenomics {
  const row = contracts[contract];
  const rules = issuanceRules as Record<string, typeof issuanceRules.BTCUSDT>;
  const rule = rules[contract];
  const stakingRule = (stakingRules as Record<string, typeof stakingRules.ETHUSDT>)[contract];
  const denominator = row?.percentageSupply ?? null;
  const events = (row?.events ?? (row?.time ? [row] : []))
    .filter((event) => event.time > now && (event.timeKind !== "interval-estimate" ||
      (event.periodStart != null && event.periodStart >= now)))
    .sort((a, b) => a.time - b.time).slice(0, 3)
    .map((event) => ({
      ...event, timeKind: event.timeKind ?? "scheduled",
      supplyPercentage: denominator && denominator > 0 ? event.amount / denominator * 100 : null,
    }));
  const anchor = stored.blockHeights?.[contract];
  let mining: Tokenomics["mining"] = null;
  if (rule && anchor) {
    const epoch = Math.floor(anchor.height / rule.halvingInterval);
    const reward = (halvings: number) => halvings >= 64 ? 0
      : Math.floor(rule.initialBlockReward * 1e8 / 2 ** halvings) / 1e8;
    const blockReward = reward(epoch);
    const nextBlockReward = reward(epoch + 1);
    const nextHalvingHeight = (epoch + 1) * rule.halvingInterval;
    mining = {
      blockHeight: anchor.height, heightSourceUrl: anchor.sourceUrl, blockReward,
      estimatedDailyIssuance: blockReward * 86400 / rule.targetBlockSeconds,
      nextHalvingHeight,
      estimatedHalvingTime: anchor.time + (nextHalvingHeight - anchor.height) * rule.targetBlockSeconds * 1000,
      nextBlockReward,
      nextEstimatedDailyIssuance: nextBlockReward * 86400 / rule.targetBlockSeconds,
    };
  }
  return {
    symbol: rule?.symbol ?? stakingRule?.symbol ?? row?.symbol ?? contract.replace(/USDT$/, ""),
    kind: rule ? "mining" : stakingRule ? "staking"
      : row && (row.events?.length || row.time || row.lockedAmount != null) ? "vesting" : "unknown",
    lockedAmount: row?.lockedAmount ?? null,
    maxSupply: rule?.maxSupply ?? row?.maxSupply ?? null,
    supplyLimit: rule ? "capped" : stakingRule ? "unlimited" : row?.supplyLimit ?? "unknown",
    percentageSupply: denominator,
    percentageBasis: row?.percentageBasis ?? null,
    events, mining,
    staking: stakingRule ? {
      mechanism: "proof-of-stake", recipients: stakingRule.recipients,
      hasFixedHalving: false, hasFeeBurn: stakingRule.hasFeeBurn,
      dailyIssuance: null, dailyBurn: null, dailyNetIssuance: null,
    } : null,
    sourceName: rule?.sourceName ?? stakingRule?.sourceName ?? row?.sourceName ?? "",
    sourceUrl: rule?.sourceUrl ?? stakingRule?.sourceUrl ?? row?.sourceUrl ?? "",
    updatedAt: rule && anchor ? anchor.time : stakingRule?.reviewedAt ?? row?.updatedAt ?? unlockSnapshotAt,
  };
}
