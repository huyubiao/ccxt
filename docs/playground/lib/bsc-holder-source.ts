import { HOLDER_LIMIT, rawInteger, tokenAmount, type HolderSnapshot } from "./holder-concentration";

export const BINPLORER_FREE_HOLDER_LIMIT = 100;
const evmAddress = /^0x[0-9a-f]{40}$/i;

export async function getBscTokenHolders(
  address: string, symbol: string, request: <T>(url: string) => Promise<T>, apiKey?: string,
): Promise<HolderSnapshot> {
  if (!evmAddress.test(address)) throw new Error("Invalid BSC token address.");
  const key = apiKey?.trim() || "freekey";
  const limit = key === "freekey" ? BINPLORER_FREE_HOLDER_LIMIT : HOLDER_LIMIT;
  const token = address.toLowerCase();
  const baseUrl = "https://api.binplorer.com";
  const params = new URLSearchParams({ apiKey: key });
  const [metadata, ranking] = await Promise.all([
    request<{ address?: string; symbol?: string; decimals?: string }>(`${baseUrl}/getTokenInfo/${token}?${params}`),
    request<{ holders?: { address: string; rawBalance: string }[] }>(
      `${baseUrl}/getTopTokenHolders/${token}?${params}&limit=${limit}`),
  ]);
  const decimals = Number(metadata?.decimals);
  if (metadata?.address?.toLowerCase() !== token || metadata.symbol?.toUpperCase() !== symbol.toUpperCase() ||
      !Number.isInteger(decimals) || decimals < 0 || decimals > 36 || !/^\d+$/.test(String(metadata.decimals))) {
    throw new Error("Unexpected Binplorer token metadata.");
  }
  if (!Array.isArray(ranking?.holders) || !ranking.holders.length || ranking.holders.length > limit) {
    throw new Error("Invalid Binplorer holder ranking.");
  }
  const seen = new Set<string>();
  const holders = ranking.holders.map((row) => {
    const holder = row?.address;
    if (typeof holder !== "string" || !evmAddress.test(holder) || seen.has(holder.toLowerCase())) {
      throw new Error("Invalid or duplicate BSC holder address.");
    }
    seen.add(holder.toLowerCase());
    return { address: holder, raw: rawInteger(row.rawBalance) };
  }).sort((a, b) => a.raw === b.raw ? 0 : a.raw > b.raw ? -1 : 1);

  return {
    status: holders.length === HOLDER_LIMIT ? "available" : "partial",
    message: holders.length < HOLDER_LIMIT ? `Binplorer 本次返回前 ${holders.length} 个地址，集中度按这些地址计算。` : null,
    symbol, chain: "BNB Smart Chain", tokenAddress: address,
    totalAmount: tokenAmount(holders.reduce((sum, { raw }) => sum + raw, 0n), decimals),
    rows: holders.map(({ address: holder, raw }) => ({
      address: holder, amount: tokenAmount(raw, decimals), label: null, explorerUrl: `https://binplorer.com/address/${holder}`,
    })),
    fetchedAt: Date.now(), stale: false, sourceName: "Binplorer", sourceUrl: `https://binplorer.com/address/${token}`,
  };
}
