import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { binanceSpot } from "./binance-markets";
import { getCmcDetail, getCoinOverview, getResearchIdentity } from "./coin-fundamentals";
import { HOLDER_LIMIT, tokenAmount, withHolderMarketCap, type HolderSnapshot } from "./holder-concentration";
import type { MarketInstrument } from "./market-lookup";
import { getNativeHolderConcentration } from "./native-holder-sources";

const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; data: HolderSnapshot }>();
const pending = new Map<string, Promise<HolderSnapshot>>();
const explorers: Record<number, { name: string; url: string }> = {
  1: { name: "Ethereum", url: "https://eth.blockscout.com" },
  10: { name: "Optimism", url: "https://optimism.blockscout.com" },
  42161: { name: "Arbitrum One", url: "https://arbitrum.blockscout.com" },
  8453: { name: "Base", url: "https://base.blockscout.com" },
};
const nativeAssets = new Set(["bitcoin", "ethereum", "solana", "sui", "binancecoin", "dogecoin",
  "litecoin", "bitcoin-cash", "avalanche-2", "tron", "ripple", "cardano", "polkadot", "cosmos"]);

type Address = {
  hash: string;
  name?: string | null;
  metadata?: { tags?: { name: string; tagType?: string }[] } | null;
};
type Page = {
  items: { address?: Address; value?: string; hash?: string; coin_balance?: string; name?: string | null; metadata?: Address["metadata"] }[];
  next_page_params: Record<string, string | number> | null;
};

function empty(pair: MarketInstrument, status: HolderSnapshot["status"], message: string): HolderSnapshot {
  return {
    status, message, symbol: pair.coin, chain: null, tokenAddress: null,
    totalAmount: null, rows: [], fetchedAt: Date.now(), stale: false,
    sourceName: "Blockscout", sourceUrl: null,
  };
}

async function fetchHolders(pair: MarketInstrument): Promise<HolderSnapshot> {
  const id = await getResearchIdentity(pair);
  if (!id) return empty(pair, "unsupported", "尚未核实该币种的链上身份。");
  const detail = await getCmcDetail(id, pair.coin);
  if (!detail) return empty(pair, "unsupported", "尚未核实该币种的链上身份。");
  const native = id === "ethereum";
  const request = <T>(url: string): Promise<T> => binanceSpot.fetch(url);
  const nativeResult = await getNativeHolderConcentration(id, detail.symbol, request);
  if (nativeResult) return nativeResult;
  if (nativeAssets.has(id) && !native) {
    return empty(pair, "unsupported", "该原生币尚未接入可分页查询前 200 地址的数据源。");
  }
  const platforms = detail.platforms ?? [];
  const platform = platforms.find((row) => row.contractId === detail.id) ?? platforms[0];
  const chain = native ? explorers[1] : platform && explorers[platform.contractChainId];
  const address = native ? null : platform?.contractAddress;
  if (!chain || (!native && (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)))) {
    return empty(pair, "unsupported", "该币种所在链尚未接入支持前 200 地址的数据源。");
  }
  const resource = native ? "/api/v2/addresses" : `/api/v2/tokens/${address}/holders`;
  const metadata = native ? null : await request<{ decimals: string; type: string }>(`${chain.url}/api/v2/tokens/${address}`);
  if (metadata && metadata.type !== "ERC-20") return empty(pair, "unsupported", "该资产不是可核实数量的 ERC-20 代币。");
  const decimals = native ? 18 : Number(metadata?.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Invalid token decimals.");
  const result = empty(pair, "available", "");
  Object.assign(result, {
    message: null, symbol: detail.symbol, chain: chain.name, tokenAddress: address,
    sourceUrl: native ? `${chain.url}/accounts` : `${chain.url}/token/${address}`,
  });
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let params = new URLSearchParams();
  let total = 0n;
  let exhausted = false;
  for (let page = 0; page < 10 && result.rows.length < HOLDER_LIMIT; page++) {
    let response: Page;
    try {
      response = await request<Page>(`${chain.url}${resource}?${params}`);
      if (!Array.isArray(response.items)) throw new Error("Invalid holders response.");
    } catch (error) {
      if (!result.rows.length) throw error;
      break;
    }
    for (const row of response.items) {
      const holder = native ? row.hash : row.address?.hash;
      const raw = native ? row.coin_balance : row.value;
      if (!holder || !/^0x[0-9a-fA-F]{40}$/.test(holder) || typeof raw !== "string" || !/^\d+$/.test(raw)) {
        throw new Error("Invalid holder balance.");
      }
      if (seen.has(holder.toLowerCase())) continue;
      seen.add(holder.toLowerCase());
      const amount = tokenAmount(BigInt(raw), decimals);
      const account = native ? row : row.address;
      result.rows.push({
        address: holder, amount,
        label: account?.metadata?.tags?.find((tag) => tag.tagType === "name")?.name ?? account?.name ?? null,
        explorerUrl: `${chain.url}/address/${holder}`,
      });
      total += BigInt(raw);
      if (result.rows.length === HOLDER_LIMIT) break;
    }
    if (!response.next_page_params) { exhausted = true; break; }
    params = new URLSearchParams();
    for (const [key, value] of Object.entries(response.next_page_params)) params.set(key, String(value));
    const cursor = params.toString();
    if (cursors.has(cursor)) break;
    cursors.add(cursor);
  }
  result.rows.sort((a, b) => Number(b.amount) - Number(a.amount));
  result.totalAmount = tokenAmount(total, decimals);
  if (!result.rows.length) result.message = "来源当前未返回持币地址。";
  if (!exhausted && result.rows.length < HOLDER_LIMIT) {
    result.status = "partial";
    result.message = `本次仅取得 ${result.rows.length} 个地址，未取得完整前 200 名。`;
  }
  result.fetchedAt = Date.now();
  return result;
}

async function load(pair: MarketInstrument): Promise<HolderSnapshot> {
  const folder = path.join(process.cwd(), ".cache", "holders");
  const file = path.join(folder, `${pair.id}.json`);
  let saved: HolderSnapshot | undefined = cache.get(pair.id)?.data;
  if (!saved) {
    try { saved = JSON.parse(await readFile(file, "utf8")) as HolderSnapshot; } catch { /* Cache may not exist yet. */ }
  }
  if (saved && (saved.status === "available" || saved.status === "partial" && saved.amountsEstimated) &&
      Date.now() - saved.fetchedAt < CACHE_MS) {
    cache.set(pair.id, { expiresAt: saved.fetchedAt + CACHE_MS, data: saved });
    return saved;
  }
  let data: HolderSnapshot;
  try { data = await fetchHolders(pair); }
  catch {
    data = saved?.rows.length ? { ...saved, stale: true, message: "刷新失败，显示上次快照。" }
      : empty(pair, "unavailable", "暂时无法取得持币地址资料，稍后可重新打开查看。");
  }
  const cacheable = data.status === "available" || data.status === "partial" && data.amountsEstimated;
  const ttl = !data.stale && (cacheable || data.status === "unsupported") ? CACHE_MS : 60000;
  cache.set(pair.id, { expiresAt: Date.now() + ttl, data });
  if (cacheable && !data.stale) {
    try {
      await mkdir(folder, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(data));
      await rename(temporary, file);
    } catch { /* The in-memory cache remains available on read-only deployments. */ }
  }
  return data;
}

function getHolderSnapshot(pair: MarketInstrument): Promise<HolderSnapshot> {
  const hit = cache.get(pair.id);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.data);
  const inFlight = pending.get(pair.id);
  if (inFlight) return inFlight;
  const request = load(pair).finally(() => pending.delete(pair.id));
  pending.set(pair.id, request);
  return request;
}

export async function getHolderConcentration(pair: MarketInstrument) {
  const [snapshot, overview] = await Promise.all([getHolderSnapshot(pair), getCoinOverview(pair).catch(() => null)]);
  const supply = overview?.market ?? overview?.tokenomics;
  return withHolderMarketCap(snapshot, supply?.supplyLimit === "capped" ? supply.maxSupply : null,
    overview?.market?.totalMarketCap ?? null);
}
