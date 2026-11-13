import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

test("a failed identity lookup or market batch leaves cached and fallback market caps usable", async (t) => {
  const pairs = Array.from({ length: 111 }, (_, index) => ({
    id: `COIN${index}USDT`, coin: `COIN${index}`, base: `COIN${index}`, type: "PERPETUAL",
  }));
  let batches = 0, fallbackCalls = 0;
  let offline = false, identityOffline = true;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const binanceSpot = { async fetch(url) {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/coins/list")) return [{ id: "match", symbol: "match" }, { id: "other-match", symbol: "match" }];
    if (pathname.includes("/exchanges/binance/tickers")) {
      return { tickers: [{ base: "MATCH", target: "USDT", coin_id: "match" }, { base: "MATCH", target: "USDC", coin_id: "other-match" }] };
    }
    if (pathname.includes("/derivatives/")) {
      if (identityOffline) throw new Error("Directory unavailable");
      return { tickers: [] };
    }
    if (pathname.endsWith("/coins/markets")) {
      batches++;
      const ids = searchParams.get("ids").split(",");
      if (offline || ids.includes("coin-100")) throw new Error("Batch unavailable");
      return ids.map((id) => ({ id, market_cap: ["coin-99", "terrausd", "bonk", "shiba-inu", "sats-ordinals",
        "bitcoin", "pancakeswap-token", "litecoin"].includes(id) ? null : 50_000 }));
    }
    if (pathname.endsWith("/simple/price")) {
      if (offline) throw new Error("Bulk fallback unavailable");
      const requested = searchParams.get("slug").split(",");
      assert.equal(searchParams.get("include_market_cap"), "true");
      return { data: [
        { slug: "bitcoin", symbol: "BTC", quotes: [{ symbol: "USD", market_cap: 1_000_000 }] },
        { slug: "pancakeswap", symbol: "CAKE", quotes: [{ symbol: "EUR", market_cap: 300 }, { symbol: "USD", market_cap: 500 }] },
        { slug: "litecoin", symbol: "LTC", quotes: [{ symbol: "USD", market_cap: 2_000 }] },
        { slug: "coin-99", symbol: "OTHER", quotes: [{ symbol: "USD", market_cap: 999 }] },
      ].filter(({ slug }) => requested.includes(slug)) };
    }
    fallbackCalls++;
    if (offline) throw new Error("Fallback unavailable");
    const slug = searchParams.get("slug");
    if (slug === "bonk1") return { data: { slug, symbol: "BONK", statistics: { marketCap: 250_000_000, price: 0.0000025 } } };
    if (slug === "shiba-inu") return { data: { slug, symbol: "SHIB", statistics: { marketCap: 2_500_000_000, price: 0.000004 } } };
    if (slug === "sats-ordinals") return { data: { slug, symbol: "SATS", statistics: { marketCap: 18_000_000 } } };
    if (slug === "terrausd") return { data: { slug, symbol: "USTC", statistics: { circulatingSupply: 5_865_600_000, price: 0.004 } } };
    if (slug === "coin-99") return { data: { slug, symbol: "COIN99", statistics: {} } };
    return { data: { slug, symbol: `COIN${slug.slice(5)}`, statistics: { marketCap: 75_000 } } };
  } };
  const fixtureKey = Symbol.for("ccxt-playground-coin-fundamentals-test");
  globalThis[fixtureKey] = { binanceSpot, pairs };
  const fixture = "const fixture = globalThis[Symbol.for('ccxt-playground-coin-fundamentals-test')];";
  const modules = {
    "./binance-markets": `${fixture} export const { binanceSpot } = fixture; export const getBinanceFuturesInstruments = async () => fixture.pairs;
      export const getBinanceFuturesMarketCaps = async (pairs) => new Map(pairs.filter(({id}) => id === 'BINANCEUSDT').map(({id}) => [id, 800]));
      export const getMarketInstrument = async (_, symbol) => symbol === 'MATCHUSDT' ? { base: 'MATCH', quote: 'USDT' } : undefined;`,
    "./binance-usdm": `export const getContractSupplyValuation = async ({id}) => id === 'PROXYUSDT' ? { price: 0.5, marketCap: 50, time: Date.now() } : null;`,
    "./coin-unlocks": `export const getStoredIdentity = symbol => ({ BTCUSDT: 'bitcoin', CAKEUSDT: 'pancakeswap-token', LTCUSDT: 'litecoin' })[symbol] ??
      (/^COIN[0-9]+USDT$/.test(symbol) && symbol !== 'COIN110USDT' ? 'coin-' + symbol.slice(4, -4) : undefined);
      export const readUnlockSnapshot = async () => ({ tokenomics: { events: [], supplyLimit: 'unknown', maxSupply: null } });`,
    "../scripts/fetch-unlock-snapshot.mjs": "export const fetchUnlockSnapshot = () => { throw Error('Unexpected unlock request'); };",
    "./coin-source-aliases.json": `export default ${readFileSync(new URL("./coin-source-aliases.json", import.meta.url), "utf8")};`,
  };
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/coin-fundamentals.ts")) {
      if (Object.hasOwn(modules, specifier)) {
        return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
      }
      if (["./coin-overview", "./market-cap-filter", "./market-lookup"].includes(specifier)) return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  } });
  t.after(() => { hooks.deregister(); delete globalThis[fixtureKey]; });

  const { getCirculatingMarketCap, getCoinOverview, getContractMarketCaps } = await import("./coin-fundamentals.ts");
  const first = getContractMarketCaps();
  assert.equal(getContractMarketCaps(), first);
  const result = await first;
  assert.equal(result.incomplete, true);
  assert.equal(result.total, pairs.length);
  assert.equal(result.caps.COIN0USDT, 50_000);
  assert.equal(result.caps.COIN100USDT, 75_000);
  assert.equal(result.caps.COIN110USDT, undefined);
  assert.deepEqual(result.missing, [
    { symbol: "COIN99USDT", reason: "cap-missing" },
    { symbol: "COIN107USDT", reason: "fallback-pending" },
    { symbol: "COIN108USDT", reason: "fallback-pending" },
    { symbol: "COIN109USDT", reason: "fallback-pending" },
    { symbol: "COIN110USDT", reason: "fallback-pending" },
  ]);
  assert.equal(batches, 2);
  assert.equal(fallbackCalls, 8);

  const gecko = await getCirculatingMarketCap(pairs[0]);
  const cmc = await getCirculatingMarketCap(pairs[100]);
  assert.equal(gecko.sourceName, "CoinGecko");
  assert.equal(cmc.sourceName, "CoinMarketCap");
  assert.equal(batches, 2);
  assert.equal(fallbackCalls, 8);

  offline = true;
  now += 2 * 60_000;
  assert.deepEqual((await getContractMarketCaps()).caps, result.caps);
  now += 20 * 60_000;
  await assert.rejects(getContractMarketCaps(), /No market caps available/);

  offline = false;
  identityOffline = false;
  now += 31_000;
  assert.equal((await getContractMarketCaps()).caps.COIN110USDT, undefined);
  assert.equal((await getCoinOverview(pairs[110])).status, "unmapped");

  const instrument = (id, coin, base = coin) => ({ id, coin, base, type: "PERPETUAL" });
  const bonk = await getCoinOverview(instrument("1000BONKUSDT", "BONK", "1000BONK"));
  assert.equal(bonk.market.circulatingMarketCap, 250_000_000);
  assert.equal(bonk.market.sourceUrl, "https://coinmarketcap.com/currencies/bonk1/");
  const ustc = await getCoinOverview(instrument("USTCUSDT", "USTC"));
  assert.equal(ustc.market.circulatingMarketCap, 23_462_400);
  const match = await getCoinOverview(instrument("MATCHUSDT", "MATCH"));
  assert.equal(match.market.sourceUrl, "https://www.coingecko.com/en/coins/match");
  const bundledMatch = await getCoinOverview(instrument("1000MATCHUSDT", "MATCH", "1000MATCH"));
  assert.equal(bundledMatch.market.sourceUrl, "https://www.coingecko.com/en/coins/match");
  const estimate = await getCoinOverview(instrument("PROXYUSDT", "PROXY"));
  assert.equal(estimate.market.circulatingMarketCap, 50);
  assert.equal(estimate.market.sourceName, "币安持仓数据估算");

  const shib = instrument("1000SHIBUSDT", "SHIB", "1000SHIB");
  const sats = instrument("1000SATSUSDT", "1000SATS");
  pairs.push(instrument("1000BONKUSDT", "BONK", "1000BONK"), instrument("USTCUSDT", "USTC"), shib, sats,
    instrument("BTCUSDT", "BTC"), instrument("CAKEUSDT", "CAKE"), instrument("LTCUSDT", "LTC"),
    instrument("PROXYUSDT", "PROXY"), instrument("BINANCEUSDT", "BINANCE"));
  now += 61_000;
  const snapshot = await getContractMarketCaps();
  assert.equal(snapshot.caps["1000BONKUSDT"], 250_000_000);
  assert.equal(snapshot.caps.USTCUSDT, 23_462_400);
  assert.equal(snapshot.caps[shib.id], 2_500_000_000);
  assert.equal(snapshot.caps[sats.id], 18_000_000);
  assert.equal(snapshot.caps.BTCUSDT, 1_000_000);
  assert.equal(snapshot.caps.CAKEUSDT, 500);
  assert.equal(snapshot.caps.LTCUSDT, 2_000);
  assert.equal(snapshot.caps.PROXYUSDT, 50);
  assert.equal(snapshot.caps.BINANCEUSDT, 800);
  assert.equal(snapshot.total, pairs.length);
  assert.equal(snapshot.caps.COIN99USDT, undefined);
  assert.equal((await getCoinOverview(shib)).market.price, 0.000004);
});
