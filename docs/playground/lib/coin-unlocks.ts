import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import snapshot from "./coin-unlock-snapshot.json" with { type: "json" };
import issuanceRules from "./coin-issuance-rules.json" with { type: "json" };
import stakingRules from "./coin-staking-rules.json" with { type: "json" };
import type { CoinUnlock, Tokenomics } from "./coin-overview";

export type StoredToken = Pick<CoinUnlock, "symbol" | "sourceName" | "sourceUrl"> & {
  time?: number;
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

export function getStoredIdentity(contract: string) {
  return contracts[contract]?.geckoId;
}

export function getTokenomics(contract: string, now = Date.now(), row = contracts[contract]): Tokenomics {
  const rules = issuanceRules as Record<string, typeof issuanceRules.BTCUSDT>;
  const rule = rules[contract];
  const stakingRule = (stakingRules as Record<string, typeof stakingRules.ETHUSDT>)[contract];
  const denominator = row?.percentageSupply ?? null;
  const reportedLocked = row?.lockedAmount;
  const lockedAmount = reportedLocked != null && Number.isFinite(reportedLocked) && reportedLocked >= 0 &&
    (denominator === null || denominator <= 0 || reportedLocked <= denominator * (1 + 1e-7)) ? reportedLocked : null;
  const events = (row?.events ?? (row?.time ? [row as CoinUnlock] : []))
    .filter((event) => event.time > now && (event.timeKind !== "interval-estimate" ||
      (event.periodStart != null && event.periodStart >= now)))
    .sort((a, b) => a.time - b.time);
  const upcoming = events.slice(0, 3)
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
    lockedAmount,
    maxSupply: rule?.maxSupply ?? row?.maxSupply ?? null,
    supplyLimit: rule ? "capped" : stakingRule ? "unlimited" : row?.supplyLimit ?? "unknown",
    percentageSupply: denominator,
    percentageBasis: row?.percentageBasis ?? null,
    events: upcoming,
    nextCliff: upcoming.some((event) => event.mechanism === "cliff")
      ? undefined : events.find((event) => event.mechanism === "cliff"),
    mining,
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

const retryInterval = 6 * 60 * 60 * 1000;
const freshnessInterval = 24 * 60 * 60 * 1000;

type CachedUnlock = { version: 1; attemptedAt: number; row?: StoredToken };
type RefreshUnlock = (prior: StoredToken | undefined, now: number) => Promise<StoredToken | undefined>;
type UnlockResult = { tokenomics: Tokenomics; geckoId?: string };

function complete(data: Tokenomics) {
  if (data.kind === "mining" || data.kind === "staking") return true;
  if (data.lockedAmount === null || data.supplyLimit === "unknown") return false;
  if (data.lockedAmount === 0 && data.events.length === 0 && !data.nextCliff) return true;
  return data.percentageSupply !== null && data.events.length === 3 &&
    data.events.every((event) => event.allocationComplete) && (data.nextCliff?.allocationComplete ?? true);
}

export function createUnlockSnapshotReader(folder: string) {
  const pending = new Map<string, Promise<UnlockResult>>();
  const unsaved = new Map<string, CachedUnlock>();

  return function readUnlockSnapshot(contract: string, refresh: RefreshUnlock, now = Date.now()): Promise<UnlockResult> {
    const inFlight = pending.get(contract);
    if (inFlight) return inFlight;
    const request = (async () => {
      const seed = contracts[contract];
      const base = getTokenomics(contract, now, seed);
      if (base.kind === "mining" || base.kind === "staking") return { tokenomics: base, geckoId: seed?.geckoId };

      const file = path.join(folder, `${encodeURIComponent(contract)}.json`);
      let cached = unsaved.get(contract);
      if (!cached) {
        try {
          const saved = JSON.parse(await readFile(file, "utf8")) as CachedUnlock;
          if (saved?.version === 1 && Number.isFinite(saved.attemptedAt) &&
              (saved.row === undefined || (typeof saved.row?.symbol === "string" && Array.isArray(saved.row.events) &&
                saved.row.events.every((event) => Number.isFinite(event?.time) && Array.isArray(event.allocations))))) {
            cached = saved;
          }
        } catch { /* A missing or unreadable snapshot can be rebuilt. */ }
      }
      if (cached && seed && (cached.row?.updatedAt ?? cached.attemptedAt) < (seed.updatedAt ?? unlockSnapshotAt)) {
        cached = undefined;
      }
      const prior = cached?.row ?? seed;
      const saved = getTokenomics(contract, now, prior);
      if ((complete(saved) && now - saved.updatedAt < freshnessInterval) || (cached && now - cached.attemptedAt < retryInterval)) {
        return { tokenomics: saved, geckoId: prior?.geckoId };
      }

      const fresh = await refresh(prior, now).catch(() => undefined);
      const row = fresh ?? cached?.row;
      const entry: CachedUnlock = { version: 1, attemptedAt: now, row };
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await mkdir(folder, { recursive: true });
        await writeFile(temporary, JSON.stringify(entry, null, 2) + "\n", { flag: "wx" });
        await rename(temporary, file);
        unsaved.delete(contract);
      } catch {
        unsaved.set(contract, entry);
        await unlink(temporary).catch(() => {});
      }
      return { tokenomics: getTokenomics(contract, now, row ?? seed), geckoId: (row ?? seed)?.geckoId };
    })().finally(() => pending.delete(contract));
    pending.set(contract, request);
    return request;
  };
}

export const readUnlockSnapshot = createUnlockSnapshotReader(path.join(process.cwd(), ".cache", "unlocks"));
