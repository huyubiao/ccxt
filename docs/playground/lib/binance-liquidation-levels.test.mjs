import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const step = 300_000;
const from = Date.UTC(2026, 10, 18);
let calls = 0;
let fail = false;
const request = async (params, build) => {
  calls++;
  if (fail) throw new Error("Temporary market data failure.");
  return Array.from({ length: params.limit }, (_, index) => build(params.startTime + index * step));
};
globalThis.liquidationTestExchange = {
  fapiPublicGetPremiumIndex: async ({ symbol }) => ({ symbol, time: from + step, markPrice: "100" }),
  fapiDataGetOpenInterestHist: (params) => request(params, (timestamp) => ({ timestamp, sumOpenInterest: "100" })),
  fapiPublicGetMarkPriceKlines: (params) => request(params, (time) =>
    [time, "100", params.symbol.startsWith("VWAP") && time === from + step ? "100.5" : "100", "100", "100"]),
  fapiPublicGetKlines: (params) => request(params, (time) => {
    const volume = params.symbol.startsWith("VWAP") && time === from ? "400" : "0";
    const quoteVolume = volume === "400" && params.symbol === "VWAPUSDT" ? "39600" : "";
    return [time, "100", "100", "99", "100", volume, time + step - 1, quoteVolume];
  }),
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const stubs = {
      "./binance-usdm": "export const binanceUsdM = globalThis.liquidationTestExchange; export const canUseContractSupply = () => false; export const readContractSupplyValuation = () => null;",
      "./coin-fundamentals": "export const getDailyMarketCaps = async () => [];",
      "./binance-margin-brackets": 'export const createBinanceMarginProfileLoader = () => async () => ({maxLeverage:75,maintenanceRate:0.01,notionalCap:10000}); export const BINANCE_MARGIN_BRACKETS_URL = "";',
    };
    if (stubs[specifier]) return nextResolve("data:text/javascript," + encodeURIComponent(stubs[specifier]), context);
    return nextResolve(specifier === "./liquidation-levels" ? specifier + ".ts" : specifier, context);
  },
});
const { getBinanceClosedMarkBars, getBinanceLiquidationLevels, getBinanceLiquidationReplay } = await import("./binance-liquidation-levels.ts");
const { BINANCE_POSITION_CALIBRATION } = await import("./liquidation-levels.ts");
hooks.deregister();

test("five-minute amount comparisons only receive closed mark candles", async (t) => {
  t.mock.method(Date, "now", () => from + step + 4_000);
  t.mock.method(globalThis.liquidationTestExchange, "fapiPublicGetMarkPriceKlines", async (params) => {
    assert.equal(params.interval, "5m");
    assert.equal(params.endTime, from + step - 1);
    return [
      [from, "100", "102", "98", "101"],
      [from + step, "101", "105", "90", "99"],
    ];
  });
  assert.deepEqual(await getBinanceClosedMarkBars("ETHUSDT"), [{ time: from, open: 100, high: 102, low: 98, close: 101 }]);
});

test("live levels show the 50x tier when Binance allows it", async (t) => {
  const symbol = "LIVEUSDT";
  const exchange = globalThis.liquidationTestExchange;
  t.mock.method(Date, "now", () => from + step);
  t.mock.method(exchange, "fapiDataGetOpenInterestHist", async () => [
    { timestamp: from, sumOpenInterest: "90" }, { timestamp: from + step, sumOpenInterest: "100" },
  ]);
  t.mock.method(exchange, "fapiPublicGetMarkPriceKlines", async () => [[from, "100", "100", "100", "100"]]);
  t.mock.method(exchange, "fapiPublicGetKlines", async () => [[from, "100", "100", "100", "100", "10"]]);
  const levels = await getBinanceLiquidationLevels({ id: symbol, type: "TRADIFI_PERPETUAL", onboardAt: from });
  assert.deepEqual(levels.leverageScenarios, [1, 2, 3, 4, 5, 7, 10, 20, 50]);
  assert.equal(levels.calibrationId, BINANCE_POSITION_CALIBRATION.id);
});

test("identical closed windows share a replay and a later window computes a fresh replay", async () => {
  const instrument = { id: "CACHEDUSDT", type: "TRADIFI_PERPETUAL", onboardAt: from };
  const first = getBinanceLiquidationReplay(instrument, from, from + 2 * step);
  assert.strictEqual(getBinanceLiquidationReplay(instrument, from, from + 2 * step), first);
  const result = await first;
  assert.equal(result.calibrationId, BINANCE_POSITION_CALIBRATION.id);
  const count = calls;
  assert.strictEqual(await getBinanceLiquidationReplay(instrument, from, from + 2 * step), result);
  assert.equal(calls, count);
  const next = await getBinanceLiquidationReplay(instrument, from, from + 3 * step);
  assert.equal(next.intervals.length, 3);
  assert.ok(calls > count);
  const shorter = await getBinanceLiquidationReplay(instrument, from + step, from + 3 * step);
  assert.equal(shorter.intervals.length, 2);
});

test("established contracts use a 24-hour position warmup and earlier marks only for volatility", async (t) => {
  const day = 24 * 60 * 60_000;
  const exchange = globalThis.liquidationTestExchange;
  const interest = t.mock.method(exchange, "fapiDataGetOpenInterestHist");
  const marks = t.mock.method(exchange, "fapiPublicGetMarkPriceKlines");
  const result = await getBinanceLiquidationReplay({ id: "WARMUPUSDT", type: "TRADIFI_PERPETUAL", onboardAt: from - 3 * day },
    from, from + step);
  assert.equal(result.warmupMinutes, 1440);
  assert.deepEqual(interest.mock.calls.map(({ arguments: [params] }) => params.startTime), [from - day]);
  assert.deepEqual(marks.mock.calls.map(({ arguments: [params] }) => params.startTime), [from - 2 * day]);
});

test("failed replays can recover on the next request", async () => {
  const instrument = { id: "RETRYUSDT", type: "TRADIFI_PERPETUAL", onboardAt: from };
  fail = true;
  await assert.rejects(getBinanceLiquidationReplay(instrument, from, from + 2 * step), /Temporary market data failure/);
  fail = false;
  assert.equal((await getBinanceLiquidationReplay(instrument, from, from + 2 * step)).intervals.length, 2);
});

test("replay reads turnover VWAP from quote volume and falls back when it is missing", async () => {
  const instrument = { type: "TRADIFI_PERPETUAL", onboardAt: from };
  const vwap = await getBinanceLiquidationReplay({ ...instrument, id: "VWAPUSDT" }, from, from + 2 * step);
  const fallback = await getBinanceLiquidationReplay({ ...instrument, id: "VWAPFALLBACKUSDT" }, from, from + 2 * step);
  assert.ok(vwap.intervals[1].short > 0);
  assert.equal(fallback.intervals[1].short, 0);
});
