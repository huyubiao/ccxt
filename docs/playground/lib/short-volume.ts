import type { VolumeWindow } from "./market-lookup";

export const MINUTE_MS = 60000;
export const VOLUME_DELAY_MS = 2000;
export const shortPeriods = [
  { period: "5s", duration: 5000 },
  { period: "30s", duration: 30000 },
  { period: "1m", duration: MINUTE_MS },
] as const;

export type RecentTrade = {
  id: number;
  time: number;
  amount: number;
  side: "buy" | "sell" | null;
};

export type RecentVolumeSeed = {
  asOf: number;
  coveredFrom?: number;
  trades: RecentTrade[];
  rates: [number, number][] | null;
};

export function parseAggregateTrade(row: {
  a: number; T: number; p: string; q: string; m?: boolean;
}, totalOnly = false): RecentTrade {
  const amount = Number(row.p) * Number(row.q);
  if (!Number.isSafeInteger(row.a) || !Number.isSafeInteger(row.T) ||
      !Number.isFinite(amount) || amount < 0 || (!totalOnly && typeof row.m !== "boolean")) {
    throw new Error("Invalid Binance aggregate trade.");
  }
  // If the buyer is the maker, the seller is the aggressor.
  return { id: row.a, time: row.T, amount, side: totalOnly ? null : row.m ? "sell" : "buy" };
}

export function sumShortVolume(
  trades: Iterable<RecentTrade>,
  end: number,
  rates: ReadonlyMap<number, number> | null,
  totalOnly = false,
  coveredFrom = -Infinity,
): VolumeWindow[] {
  const totals = shortPeriods.map(({ period }) => ({ period, amounts: { buy: 0, sell: 0 }, total: 0 }));
  const incomplete = new Set<VolumeWindow["period"]>();
  for (const trade of trades) {
    const age = end - trade.time;
    if (age <= 0 || age > MINUTE_MS) continue;
    const rate = rates === null ? 1 : rates.get(Math.floor(trade.time / MINUTE_MS) * MINUTE_MS);
    for (const [index, { period, duration }] of shortPeriods.entries()) {
      if (age > duration) continue;
      if (rate === undefined) incomplete.add(period);
      else if (totalOnly) totals[index].total += trade.amount * rate;
      else if (trade.side !== null) totals[index].amounts[trade.side] += trade.amount * rate;
      else incomplete.add(period);
    }
  }
  return totals.map(({ period, amounts, total }, index) => {
    const complete = !incomplete.has(period) && end - shortPeriods[index].duration >= coveredFrom;
    return totalOnly ? { period, amounts: null, total: complete ? total : null }
      : { period, amounts: complete ? amounts : null };
  });
}
