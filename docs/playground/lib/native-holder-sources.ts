import { circulatingPercentage, HOLDER_LIMIT, parseBitcoinRichList, rawInteger, tokenAmount,
  type HolderConcentration } from "./holder-concentration";

type Request = <T>(url: string) => Promise<T>;
type NativeRow = { address: string; raw: bigint; label: string | null };

export async function getNativeHolderConcentration(
  id: string, symbol: string, supply: number | null, request: Request,
): Promise<HolderConcentration | null> {
  let rows: NativeRow[];
  let chain: string;
  let decimals: number;
  let sourceName: string;
  let sourceUrl: string;
  let addressUrl: (address: string) => string;
  let balanceScope: string;
  let amountsEstimated = false;
  if (id === "bitcoin") {
    sourceUrl = "https://www.coinlore.com/coin/bitcoin/richlist";
    rows = parseBitcoinRichList(await request<string>(sourceUrl));
    chain = "Bitcoin"; decimals = 8; sourceName = "CoinLore";
    addressUrl = (address) => `https://mempool.space/address/${address}`;
    balanceScope = "仅取得来源公开的前 100 名，余额为页面展示的近似值。";
    amountsEstimated = true;
  } else if (id === "ripple") {
    const response = await request<{ account: string; balance: string | number; escrow?: string | number;
      supply: string | number; name?: { name?: string; desc?: string } }[]>("https://api.xrpscan.com/api/v1/balances");
    if (!Array.isArray(response) || response.length < HOLDER_LIMIT) throw new Error("Incomplete XRP ranking.");
    rows = response.map((row) => {
      const raw = rawInteger(row.supply);
      const escrow = row.escrow == null ? 0n : rawInteger(row.escrow);
      if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(row.account) ||
          raw !== rawInteger(row.balance) + escrow) throw new Error("Invalid XRP balance.");
      return { address: row.account, raw, label: row.name?.name ?? null };
    });
    chain = "XRP Ledger"; decimals = 6; sourceName = "XRPSCAN";
    sourceUrl = "https://xrpscan.com/balances";
    addressUrl = (address) => `https://xrpscan.com/account/${address}`;
    balanceScope = "账户余额加托管（Escrow）余额，来源每晚更新。";
  } else if (id === "tron") {
    rows = [];
    for (let start = 0; start < HOLDER_LIMIT; start += 50) {
      const response = await request<{ data: { address: string; totalBalance: string | number; addressTag?: string }[] }>(
        `https://apilist.tronscanapi.com/api/account/list?sort=-balance&limit=50&start=${start}`);
      if (!Array.isArray(response.data) || response.data.length !== 50) throw new Error("Incomplete TRX ranking.");
      for (const row of response.data) {
        if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(row.address)) throw new Error("Invalid TRX address.");
        rows.push({ address: row.address, raw: rawInteger(row.totalBalance), label: row.addressTag ?? null });
      }
    }
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].raw > rows[i - 1].raw) throw new Error("Unexpected TRX ranking order.");
    }
    chain = "TRON"; decimals = 6; sourceName = "TRONSCAN";
    sourceUrl = "https://tronscan.org/#/data/accounts";
    addressUrl = (address) => `https://tronscan.org/#/address/${address}`;
    balanceScope = "账户总余额（含质押及解质押中的余额）。";
  } else {
    return null;
  }
  rows.sort((a, b) => a.raw === b.raw ? 0 : a.raw > b.raw ? -1 : 1);
  rows = rows.slice(0, HOLDER_LIMIT);
  if (new Set(rows.map((row) => row.address)).size !== rows.length) throw new Error("Duplicate holder addresses.");
  const totalAmount = tokenAmount(rows.reduce((sum, row) => sum + row.raw, 0n), decimals);
  return {
    status: rows.length === HOLDER_LIMIT ? "available" : "partial",
    message: rows.length < HOLDER_LIMIT ? `免费来源当前仅有前 ${rows.length} 名，尚未取得完整前 200 名。` : null,
    symbol, chain, tokenAddress: null, circulatingSupply: supply, totalAmount,
    circulatingPercentage: circulatingPercentage(totalAmount, supply),
    rows: rows.map((row) => {
      const amount = tokenAmount(row.raw, decimals);
      return { address: row.address, amount, label: row.label, explorerUrl: addressUrl(row.address),
        circulatingPercentage: circulatingPercentage(amount, supply) };
    }),
    fetchedAt: Date.now(), stale: false, sourceName, sourceUrl, balanceScope, amountsEstimated,
  };
}
