import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { binanceSpot } from "./binance-markets";
import { BINPLORER_FREE_HOLDER_LIMIT, getBscTokenHolders } from "./bsc-holder-source";
import { getCmcDetail, getCoinOverview, getGeckoTokenPlatforms, getResearchIdentity } from "./coin-fundamentals";
import { HOLDER_LIMIT, tokenAmount, withHolderMarketCap, type HolderSnapshot } from "./holder-concentration";
import { geckoHolderPlatforms, holderExplorers, supportedHolderPlatforms } from "./holder-platforms";
import type { MarketInstrument } from "./market-lookup";
import { getNativeHolderConcentration } from "./native-holder-sources";

const CACHE_MS = 6 * 60 * 60 * 1000;
const holderResolutionVersion = 4;
const cache = new Map<string, { expiresAt: number; data: HolderSnapshot }>();
const pending = new Map<string, Promise<HolderSnapshot>>();
const nativeAssets = new Set(["bitcoin", "ethereum", "solana", "sui", "binancecoin", "dogecoin",
  "litecoin", "bitcoin-cash", "avalanche-2", "tron", "ripple", "cardano", "polkadot", "cosmos",
  "aptos", "the-open-network", "toncoin", "near", "initia", "celestia", "injective", "theta-token"]);

type Request = <T>(url: string) => Promise<T>;

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
    sourceName: "", sourceUrl: null,
  };
}

async function fetchHolders(pair: MarketInstrument): Promise<HolderSnapshot> {
  const id = await getResearchIdentity(pair);
  if (!id) return empty(pair, "unsupported", "尚未核实该币种的链上身份。");
  const request: Request = (url) => binanceSpot.fetch(url);
  const nativeResult = await getNativeHolderConcentration(id, pair.coin, request);
  if (nativeResult) return nativeResult;
  if (id === "ethereum") return fetchBlockscoutHolders(pair, holderExplorers[1], null, request);
  if (nativeAssets.has(id)) {
    return empty(pair, "unsupported", "该原生币所在链尚无已接入的地址排名来源。");
  }

  let upstreamFailed = false;
  let verified = false;
  const tried = new Set<string>();
  const readGecko = () => getGeckoTokenPlatforms(id, pair.coin).catch(() => { upstreamFailed = true; return null; });
  async function tryPlatforms(platforms: Parameters<typeof supportedHolderPlatforms>[0]) {
    for (const { contractChainId, contractAddress } of supportedHolderPlatforms(platforms, id)) {
      const key = `${contractChainId}:${contractAddress.toLowerCase()}`;
      if (tried.has(key)) continue;
      tried.add(key);
      try {
        const result = contractChainId === 56
          ? await getBscTokenHolders(contractAddress, pair.coin, request, process.env.BINPLORER_API_KEY)
          : await fetchBlockscoutHolders(pair, holderExplorers[contractChainId], contractAddress, request);
        if (result.rows.length) return result;
      } catch { upstreamFailed = true; }
    }
  }

  const cmc = await getCmcDetail(id, pair.coin).catch(() => { upstreamFailed = true; return null; });
  const cmcPlatforms = cmc?.platforms ?? [];
  const multipleChains = new Set(cmcPlatforms.map(({ contractChainId }) => contractChainId)).size > 1;
  const primaryMetadata = multipleChains ? await readGecko() : null;
  if (cmc) {
    verified = true;
    const primary = primaryMetadata?.asset_platform_id;
    const preferred = primary && primaryMetadata?.platforms?.[primary];
    const result = await tryPlatforms(primary && preferred
      ? [...geckoHolderPlatforms({ [primary]: preferred }), ...cmcPlatforms] : cmcPlatforms);
    if (result) return result;
  }
  const gecko = multipleChains ? primaryMetadata : await readGecko();
  if (gecko) {
    verified = true;
    const result = await tryPlatforms(geckoHolderPlatforms(gecko.platforms ?? {}, gecko.asset_platform_id));
    if (result) return result;
  }
  if (upstreamFailed) throw new Error("Holder data providers unavailable.");
  return empty(pair, "unsupported", verified ? "该币种尚无可用的已核实链上地址排名。" : "尚未核实该币种的链上身份。");
}

async function fetchBlockscoutHolders(pair: MarketInstrument, chain: { name: string; url: string }, address: string | null, request: Request) {
  const native = address === null;
  const resource = native ? "/api/v2/addresses" : `/api/v2/tokens/${address}/holders`;
  const metadata = native ? null : await request<{ decimals: string; type: string }>(`${chain.url}/api/v2/tokens/${address}`);
  if (metadata && metadata.type !== "ERC-20") return empty(pair, "unsupported", "该资产不是可核实数量的 ERC-20 代币。");
  const decimals = native ? 18 : Number(metadata?.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Invalid token decimals.");
  const result = empty(pair, "available", "");
  Object.assign(result, {
    message: null, chain: chain.name, tokenAddress: address, sourceName: "Blockscout",
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
      const query = params.toString();
      response = await request<Page>(`${chain.url}${resource}${query ? `?${query}` : ""}`);
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

function isCacheable(data: HolderSnapshot) {
  if (!data.rows.length) return false;
  const binplorerKey = process.env.BINPLORER_API_KEY?.trim();
  return data.status === "available" || data.status === "partial" && (data.amountsEstimated ||
    (data.sourceName === "Binplorer" && data.rows.length === BINPLORER_FREE_HOLDER_LIMIT &&
      (!binplorerKey || binplorerKey === "freekey")));
}

async function load(pair: MarketInstrument): Promise<HolderSnapshot> {
  const folder = path.join(process.cwd(), ".cache", "holders");
  const file = path.join(folder, `${pair.id}.json`);
  let saved: HolderSnapshot | undefined = cache.get(pair.id)?.data;
  if (!saved) {
    try { saved = JSON.parse(await readFile(file, "utf8")) as HolderSnapshot; } catch { /* Cache may not exist yet. */ }
  }
  if (saved?.resolutionVersion === holderResolutionVersion && isCacheable(saved) && Date.now() - saved.fetchedAt < CACHE_MS) {
    cache.set(pair.id, { expiresAt: saved.fetchedAt + CACHE_MS, data: saved });
    return saved;
  }
  let data: HolderSnapshot;
  try { data = { ...await fetchHolders(pair), resolutionVersion: holderResolutionVersion }; }
  catch {
    data = saved?.rows.length ? { ...saved, stale: true, message: "刷新失败，显示上次快照。" }
      : empty(pair, "unavailable", "暂时无法取得持币地址资料，稍后可重新打开查看。");
  }
  const cacheable = isCacheable(data);
  const ttl = !data.stale && cacheable && data.rows.length ? CACHE_MS : 60000;
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
