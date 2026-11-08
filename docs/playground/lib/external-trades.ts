import type { RecentTrade } from "./short-volume";

type Side = NonNullable<RecentTrade["side"]>;

function normalize(id: unknown, time: number, price: unknown, size: unknown, side: unknown): RecentTrade {
  const tradeId = Number(id);
  const amount = Number(price) * Number(size);
  if (id == null || !Number.isSafeInteger(tradeId) || tradeId < 0 || !Number.isFinite(time) ||
      !Number.isFinite(amount) || amount <= 0 || (side !== "buy" && side !== "sell")) {
    throw new Error("Invalid public trade.");
  }
  return { id: tradeId, time, amount, side };
}

export function okxTrade(row: { tradeId: string; ts: string; px: string; sz: string; side: Side }, contractSize: number) {
  return normalize(row.tradeId, Number(row.ts), row.px, Number(row.sz) * contractSize, row.side);
}
