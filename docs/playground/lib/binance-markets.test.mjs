import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

test("groups bundled contracts using verified mappings or the Binance spot index pair", async (t) => {
  const bases = ["1000SHIB", "1000CAT", "1000SATS", "1000000MOG", "1000NEW", "1000OTHER", "1INCH"];
  const contracts = bases.map((base) => ({ id: `${base}USDT`, base, quote: "USDT", type: "PERPETUAL", onboardAt: 0 }));
  const indexRequests = [];
  const marketRequests = [];
  const marketRows = [
    { symbol: "SHIBUSDT", baseAsset: "SHIB", quoteAsset: "USDT", marketCap: "200" },
    { symbol: "CATUSDT", baseAsset: "CAT", quoteAsset: "USDT", marketCap: 300 },
    { symbol: "1000SATSUSDT", baseAsset: "1000SATS", quoteAsset: "USDT", marketCap: 400 },
    { symbol: "MOGUSDT", baseAsset: "MOG", quoteAsset: "USDC", marketCap: 500 },
    { symbol: "1INCHUSDT", baseAsset: "1INCH", quoteAsset: "USDT", marketCap: 0 },
    { symbol: "NEWUSDT", baseAsset: "NEW", quoteAsset: "USDT", marketCap: 600 },
  ];
  const key = Symbol.for("playground-binance-market-fixture");
  globalThis[key] = { contracts, indexRequests, marketRequests, marketRows };
  const modules = {
    ccxt: `const fixture = globalThis[Symbol.for('playground-binance-market-fixture')];
      export default { binance: class { async fetch(url) {
        fixture.marketRequests.push(url);
        return { code: '000000', data: fixture.marketRows };
      } } };`,
    "./binance-usdm": `const fixture = globalThis[Symbol.for('playground-binance-market-fixture')];
      export const getContractDirectory = async () => ({ contracts: fixture.contracts });
      export const binanceUsdM = { async fapiPublicGetConstituents({ symbol }) {
        fixture.indexRequests.push(symbol);
        return { symbol, constituents: symbol === '1000NEWUSDT' ? [{ exchange: 'binance', symbol: 'newusdt' }]
          : [{ exchange: 'another-exchange', symbol: 'OTHERUSDT' }] };
      } };`,
    "./external-markets": "export const getExternalQuote = () => {}; export const loadExternalPairs = () => [];",
  };
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/binance-markets.ts")) {
      if (Object.hasOwn(modules, specifier)) {
        return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
      }
      if (specifier === "./market-lookup") return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  } });
  t.after(() => { hooks.deregister(); delete globalThis[key]; });

  const { getBinanceFuturesInstruments, getBinanceFuturesMarketCaps } = await import("./binance-markets.ts");
  const instruments = await getBinanceFuturesInstruments();
  assert.deepEqual(instruments.map(({ coin }) => coin), ["SHIB", "1000CAT", "1000SATS", "MOG", "NEW", "1000OTHER", "1INCH"]);
  assert.deepEqual(instruments.map(({ id }) => id), contracts.map(({ id }) => id));
  assert.deepEqual(indexRequests, ["1000NEWUSDT", "1000OTHERUSDT"]);
  await getBinanceFuturesInstruments();
  assert.equal(indexRequests.length, 2);
  const caps = await getBinanceFuturesMarketCaps([
    ...instruments, { id: "NEWUSDT", base: "NEW", quote: "USDT", type: "TRADIFI_PERPETUAL" },
  ]);
  assert.deepEqual(Object.fromEntries(caps), { "1000SHIBUSDT": 200, "1000SATSUSDT": 400 });
  assert.deepEqual(marketRequests, ["https://www.binance.com/bapi/composite/v1/public/marketing/symbol/list"]);
});
