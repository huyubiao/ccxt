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

export function coinbaseSpotTrade(row: { trade_id: number; time: string; price: string; size: string; side: Side }) {
  // Coinbase Exchange reports the maker's side.
  if (row.side !== "buy" && row.side !== "sell") throw new Error("Missing Coinbase maker side.");
  return normalize(row.trade_id, Date.parse(row.time), row.price, row.size, row.side === "buy" ? "sell" : "buy");
}

export function coinbasePerpetualTrade(row: { trade_seq: number; timestamp: number; price: number; amount: number; direction: Side }) {
  return normalize(row.trade_seq, row.timestamp, row.price, row.amount, row.direction);
}

export function okxTrade(row: { tradeId: string; ts: string; px: string; sz: string; side: Side }, contractSize: number) {
  return normalize(row.tradeId, Number(row.ts), row.px, Number(row.sz) * contractSize, row.side);
}
