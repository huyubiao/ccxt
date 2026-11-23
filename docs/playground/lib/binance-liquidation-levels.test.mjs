import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const step = 300_000;
const from = Date.UTC(2026, 10, 18);
globalThis.liquidationTestExchange = {
  fapiPublicGetPremiumIndex: async ({ symbol }) => ({ symbol, time: from + step, markPrice: "100" }),
  fapiDataGetOpenInterestHist: async () => [],
  fapiPublicGetMarkPriceKlines: async () => [],
  fapiPublicGetKlines: async () => [],
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
const { getBinanceClosedMarkBars, getBinanceLiquidationLevels } = await import("./binance-liquidation-levels.ts");
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
