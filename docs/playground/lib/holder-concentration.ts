export const HOLDER_LIMIT = 200;

type HolderBalance = {
  address: string;
  amount: string;
  label: string | null;
  explorerUrl: string;
};

export type HolderSnapshot = {
  status: "available" | "partial" | "unsupported" | "unavailable";
  message: string | null;
  symbol: string;
  chain: string | null;
  tokenAddress: string | null;
  totalAmount: string | null;
  rows: HolderBalance[];
  fetchedAt: number;
  stale: boolean;
  sourceName: string;
  sourceUrl: string | null;
  balanceScope?: string;
  amountsEstimated?: boolean;
};

export type HolderConcentration = Omit<HolderSnapshot, "rows"> & {
  maxSupply: number | null;
  totalMarketCap: number | null;
  totalMarketCapPercentage: number | null;
  rows: (HolderBalance & { totalMarketCapPercentage: number | null })[];
};

export function tokenAmount(raw: bigint, decimals: number): string {
  if (raw < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("Invalid token amount.");
  }
  if (decimals === 0) return String(raw);
  const digits = String(raw).padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return digits.slice(0, -decimals) + (fraction ? "." + fraction : "");
}

export function holderMarketCapPercentage(amount: string, maxSupply: number | null) {
  if (maxSupply === null || !Number.isFinite(maxSupply) || maxSupply <= 0) return null;
  const percentage = Number(amount) / maxSupply * 100;
  return Number.isFinite(percentage) ? percentage : null;
}

export function withHolderMarketCap(snapshot: HolderSnapshot, maxSupply: number | null, totalMarketCap: number | null): HolderConcentration {
  const { status, message, symbol, chain, tokenAddress, totalAmount, fetchedAt, stale,
    sourceName, sourceUrl, balanceScope, amountsEstimated } = snapshot;
  return { status, message, symbol, chain, tokenAddress, totalAmount, fetchedAt, stale, sourceName, sourceUrl,
    balanceScope, amountsEstimated, maxSupply, totalMarketCap,
    totalMarketCapPercentage: totalAmount === null ? null : holderMarketCapPercentage(totalAmount, maxSupply),
    rows: snapshot.rows.map(({ address, amount, label, explorerUrl }) => ({ address, amount, label, explorerUrl,
      totalMarketCapPercentage: holderMarketCapPercentage(amount, maxSupply) })),
  };
}

export function rawInteger(value: unknown): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Unsafe balance.");
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid balance.");
  return BigInt(value);
}

export function parseBitcoinRichList(html: string) {
  const rows: { address: string; raw: bigint; label: string | null }[] = [];
  const seen = new Set<string>();
  const pattern = /<tr>\s*<th\b[^>]*scope=["']row["'][^>]*>(\d+)<\/th>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([a-zA-Z0-9]+)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
  for (const match of html.matchAll(pattern)) {
    const [, rank, balance, address, label] = match;
    if (Number(rank) !== rows.length + 1 || seen.has(address) ||
        !/^(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[ac-hj-np-z02-9]{11,87})$/.test(address)) {
      throw new Error("Invalid Bitcoin ranking.");
    }
    const quantity = balance.replace(/,/g, "").trim();
    if (!/^\d+(?:\.\d{1,8})?$/.test(quantity)) throw new Error("Invalid Bitcoin balance.");
    const [whole, fraction = ""] = quantity.split(".");
    const raw = BigInt(whole + fraction.padEnd(8, "0"));
    if (rows.length && raw > rows[rows.length - 1].raw) throw new Error("Unsorted Bitcoin ranking.");
    seen.add(address);
    rows.push({ address, raw, label: label.replace(/<[^>]+>/g, "").trim() || null });
  }
  if (rows.length !== 100) throw new Error("Incomplete Bitcoin top-100 source.");
  return rows;
}
