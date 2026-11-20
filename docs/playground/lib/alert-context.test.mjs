import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

test("alert ratio requests return both Binance ratios without querying OKX", async (t) => {
  const time = Date.now();
  const key = Symbol.for("playground-alert-context-fixture");
  const calls = [];
  globalThis[key] = { time, calls };
  const fixture = `const { time, calls } = globalThis[Symbol.for('${Symbol.keyFor(key)}')];`;
  const modules = {
    "@/lib/binance-markets": `${fixture}
      export const getMarketInstrument = (...args) => { calls.push(args); return { id: 'BTCUSDT' }; };
      export const findOkxPerpetuals = () => { calls.push(['OKX']); return Promise.resolve([]); };`,
    "@/lib/binance-usdm": `${fixture}
      export const binanceUsdM = {
        async fapiDataGetGlobalLongShortAccountRatio(query) {
          calls.push(['accounts', query]);
          return [{ timestamp: time - 1000, longShortRatio: '1', longAccount: '0.5', shortAccount: '0.5' }];
        },
        async fapiDataGetTopLongShortPositionRatio(query) {
          calls.push(['positions', query]);
          return [{ timestamp: time - 1000, longShortRatio: '3', longPosition: '0.75', shortPosition: '0.25' }];
        },
      };`,
    "@/lib/binance-volume": "export const getAlertTurnover = () => { throw new Error('Unexpected turnover request'); }; export const getAlertTurnoverComparison = getAlertTurnover;",
    "@/lib/external-markets": "export const getOkxAlertRatios = () => { throw new Error('Unexpected OKX ratio request'); };",
    "@/lib/short-volume": "export const VOLUME_DELAY_MS = 0;",
  };
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/alert-context/route.ts")) {
      if (Object.hasOwn(modules, specifier)) {
        return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
      }
      if (specifier === "next/server") return next("next/server.js", context);
      if (specifier === "@/lib/price-alerts") return next("../../../../lib/price-alerts.ts", context);
    }
    return next(specifier, context);
  } });
  t.after(() => { hooks.deregister(); delete globalThis[key]; });

  const { GET } = await import("../app/api/markets/alert-context/route.ts");
  const nextUrl = new URL(`http://localhost/api/markets/alert-context?symbol=BTCUSDT&seconds=30&time=${time}&view=ratios`);
  const response = await GET({ nextUrl });
  assert.equal(response.status, 200);
  const query = { symbol: "BTCUSDT", period: "5m", limit: 2, endTime: time };
  assert.deepEqual(calls, [["futures", "BTCUSDT", "binance"], ["accounts", query], ["positions", query]]);
  assert.deepEqual(await response.json(), {
    turnover: null,
    binanceAccounts: { ratio: 1, long: 0.5, short: 0.5, time: time - 1000 },
    binancePositions: { ratio: 3, long: 0.75, short: 0.25, time: time - 1000 },
  });
});
