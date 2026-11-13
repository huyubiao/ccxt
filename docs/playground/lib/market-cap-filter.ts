import type { FuturesContract } from "./market-lookup";

export const MARKET_CAP_REFRESH_MS = 5 * 60_000;
export const MARKET_CAP_RETRY_MS = 30_000;
export const MARKET_CAP_UNIT_USD = 10_000;

export type MarketCapRange = { min: number | null; max: number | null };
export type ContractMarketCaps = Readonly<Partial<Record<string, number>>>;
export type MissingContractMarketCap = {
  symbol: string;
  reason: "unmapped" | "identity-unavailable" | "cap-missing" | "cap-unavailable" | "fallback-pending";
};
export type ContractMarketCapSnapshot = {
  caps: ContractMarketCaps;
  total: number;
  incomplete: boolean;
  missing: MissingContractMarketCap[];
};

const decimalAmount = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

export function convertMarketCapBound(input: string, from: "usd" | "ten-thousand-usd"): string {
  const value = input.trim();
  if (!decimalAmount.test(value)) return value;

  // Shift the decimal text so fractional input keeps exact dollar boundaries.
  const [whole, fraction = ""] = value.split(".");
  const dollars = whole.padStart(5, "0");
  const decimals = fraction.padEnd(4, "0");
  const [integerPart, fractionPart] = from === "usd"
    ? [dollars.slice(0, -4), dollars.slice(-4) + fraction]
    : [whole + decimals.slice(0, 4), decimals.slice(4)];
  const integer = integerPart.replace(/^0+/, "") || "0";
  const remainder = fractionPart.replace(/0+$/, "");
  return remainder ? `${integer}.${remainder}` : integer;
}

function parseBound(input: string): number | null {
  const value = input.trim();
  if (!value) return null;
  if (!decimalAmount.test(value)) return NaN;
  return Number(value);
}

export function parseMarketCapRange(minInput: string, maxInput: string): MarketCapRange | null | undefined {
  const min = parseBound(minInput);
  const max = parseBound(maxInput);
  if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) return undefined;
  if (min !== null && max !== null && min > max) return undefined;
  return min === null && max === null ? null : { min, max };
}

export function selectMonitoredContracts(
  contracts: readonly Pick<FuturesContract, "id" | "type">[],
  range: MarketCapRange | null,
  marketCaps: ContractMarketCaps | null,
): Set<string> {
  if (range === null) return new Set(contracts.map(({ id }) => id));
  const symbols = new Set<string>();
  for (const { id, type } of contracts) {
    const cap = marketCaps?.[id];
    if (type !== "PERPETUAL" || cap === undefined || !Number.isFinite(cap) || cap <= 0) continue;
    if ((range.min === null || cap >= range.min) && (range.max === null || cap <= range.max)) symbols.add(id);
  }
  return symbols;
}
