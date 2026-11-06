import { binanceSpot } from "./binance-markets";
import { positiveNumber, type CoinUnlock, type UnlockAllocation } from "./coin-overview";

type UnlockRow = {
  slug: string;
  symbol: string;
  nextUnlocked?: { date?: number; tokenAmount?: number };
  nextUnlockedDetail?: { allocationName?: string; tokenAmount?: number; vestingType?: string }[];
};

type UnlockPage = { rows: UnlockRow[]; pages: number };
type ListingResponse = {
  status?: { error_code?: string };
  data?: { tokenUnlockList?: UnlockRow[]; totalCount?: string };
};

const pageSize = 100;
const ttl = 5 * 60_000;
const pages = new Map<number, { expiresAt: number; pending: Promise<UnlockPage> }>();
const fallback = new Map<string, { expiresAt: number; pending: Promise<CoinUnlock | null> }>();

function getPage(page: number) {
  const cached = pages.get(page);
  if (cached && Date.now() < cached.expiresAt) return cached.pending;

  const url = `https://api.coinmarketcap.com/data-api/v3/token-unlock/listing?start=${page}&limit=${pageSize}`;
  const pending = (binanceSpot.fetch(url) as Promise<ListingResponse>).then(({ data, status }) => {
    if (status?.error_code !== "0" || !data) throw new Error("CoinMarketCap unlock directory unavailable.");
    const pageCount = Math.ceil((positiveNumber(data.totalCount) ?? 0) / pageSize);
    if (page === 1 && !Array.isArray(data.tokenUnlockList)) throw new Error("CoinMarketCap unlock directory is missing.");
    return { rows: data.tokenUnlockList ?? [], pages: pageCount };
  }).catch((error) => {
    if (pages.get(page)?.pending === pending) pages.delete(page);
    throw error;
  });
  pages.set(page, { expiresAt: Date.now() + ttl, pending });
  return pending;
}

function allocationGroup(name: string): UnlockAllocation["group"] {
  if (/\b(foundation|treasury|dao|ecosystem|liquidity|staking|reserve|market maker)\b/i.test(name)) return "other";
  if (/\b(team|founders?|advisors?|advisers?|investors?|contributors?|employees?|private sale|seed (sale|round))\b/i.test(name)) return "insiders";
  if (/\b(public sale|community sale|user|users|airdrop|individual wallets)\b/i.test(name)) return "users";
  return "other";
}

function parseUnlock(row: UnlockRow): CoinUnlock | null {
  const time = positiveNumber(row.nextUnlocked?.date);
  const amount = positiveNumber(row.nextUnlocked?.tokenAmount);
  if (time === null || time <= Date.now() || time > 8.64e15 || amount === null) return null;

  let allocations: UnlockAllocation[] = (row.nextUnlockedDetail ?? []).flatMap((detail) => {
    const name = detail.allocationName?.trim();
    return name ? [{ name, amount: positiveNumber(detail.tokenAmount), group: allocationGroup(name) }] : [];
  });
  const subtotal = allocations.reduce((sum, detail) => sum + (detail.amount ?? 0), 0);
  const tolerance = Math.max(1e-7, amount * 1e-7);
  const allocationComplete = allocations.length > 0 && allocations.every((detail) => detail.amount !== null) &&
    Math.abs(amount - subtotal) <= tolerance;
  if (subtotal > amount + tolerance) {
    allocations = [];
  } else if (allocations.length && amount - subtotal > tolerance && allocations.every((detail) => detail.amount !== null)) {
    allocations.push({ name: "分配用途未披露", amount: amount - subtotal, group: "other" });
  }
  const kinds = new Set(row.nextUnlockedDetail?.map((detail) => detail.vestingType?.toLowerCase()));
  const mechanism = kinds.size === 1 ? (kinds.has("cliff") ? "cliff" : kinds.has("linear") ? "linear" : null) : null;
  return {
    symbol: row.symbol.toUpperCase(), time, amount, mechanism, allocations, allocationComplete,
    sourceUrl: "https://coinmarketcap.com/token-unlocks/",
    sourceName: "CoinMarketCap",
  };
}

async function searchCalendar(id: string, symbol: string) {
  const matches = (row: UnlockRow) => row.slug === id && row.symbol?.toUpperCase() === symbol.toUpperCase();
  const first = await getPage(1);
  const firstMatch = first.rows.find(matches);
  if (firstMatch) return parseUnlock(firstMatch);

  // The public calendar paginates by page number and caps each response at 100 rows.
  // Search in small batches and reuse pages across coins.
  let incomplete = false;
  for (let page = 2; page <= first.pages; page += 4) {
    const batch = await Promise.allSettled(Array.from({ length: Math.min(4, first.pages - page + 1) }, (_, index) => getPage(page + index)));
    for (const result of batch) {
      if (result.status === "rejected") {
        incomplete = true;
        continue;
      }
      const match = result.value.rows.find(matches);
      if (match) return parseUnlock(match);
    }
  }
  if (incomplete) throw new Error("CoinMarketCap unlock directory search was incomplete.");
  return null;
}

type PublicDataset = {
  "@type"?: string;
  identifier?: string;
  variableMeasured?: { name: string; value: string | number }[];
};

async function getPublicSummary(id: string, symbol: string): Promise<CoinUnlock | null> {
  const sourceUrl = `https://tokenomist.ai/${encodeURIComponent(id)}`;
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Tokenomist summary unavailable.");
  const html = await response.text();
  for (const [, content] of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let graph: PublicDataset[];
    try {
      const parsed = JSON.parse(content);
      graph = Array.isArray(parsed?.["@graph"]) ? parsed["@graph"] : [parsed];
    } catch {
      continue;
    }
    const dataset = graph.find((entry) => entry?.["@type"] === "Dataset" && entry.identifier === `tokenomist:${id}`);
    if (!Array.isArray(dataset?.variableMeasured)) continue;
    const fields = new Map(dataset.variableMeasured.map(({ name, value }) => [name, value]));
    if (String(fields.get("Token Symbol")).toUpperCase() !== symbol.toUpperCase()) continue;
    const time = Date.parse(String(fields.get("Next Unlock Date")));
    const amount = positiveNumber(fields.get("Next Unlock Amount"));
    if (!Number.isFinite(time) || time <= Date.now() || amount === null) return null;
    const label = fields.get("Next Unlock Allocation");
    // The public summary names recipients but provides no per-recipient amounts.
    const allocations = typeof label === "string" && label.trim()
      ? [{ name: label.trim(), amount: null, group: "other" as const }] : [];
    return {
      symbol: symbol.toUpperCase(), time, amount, mechanism: null, allocations, allocationComplete: false,
      sourceUrl, sourceName: "Tokenomist",
    };
  }
  return null;
}

function readPublicSummary(id: string, symbol: string) {
  const key = `${id}:${symbol}`;
  const cached = fallback.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.pending;
  const pending = getPublicSummary(id, symbol).catch((error) => {
    if (fallback.get(key)?.pending === pending) fallback.delete(key);
    throw error;
  });
  fallback.set(key, { expiresAt: Date.now() + ttl, pending });
  return pending;
}

export async function getNextUnlock(id: string, symbol: string) {
  if (id === "bitcoin") return null; // Mining issuance has no stakeholder vesting schedule.
  const calendar = await searchCalendar(id, symbol).catch(() => undefined);
  if (calendar) return calendar;
  const summary = await readPublicSummary(id, symbol);
  if (summary && summary.time > Date.now()) return summary;
  if (calendar === undefined) throw new Error("Could not verify the unlock calendar.");
  return null;
}
