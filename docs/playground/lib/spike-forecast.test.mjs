import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareForecast, estimateAlertMove, forecastAccuracy, forecastAlertMove, forecastSpike, getRecordForecast, largeTradeSide, readForecastClose,
  summarizeTradePressure,
} from "./spike-forecast.ts";
import { groupLiquidationTable, latestOpenInterestChange, normalizeOpenInterest } from "./liquidation-levels.ts";
import { summarizeDepthNearMid } from "./order-book.ts";
import { sumShortVolume } from "./short-volume.ts";

const empty = { flow: null, depth: null, interest: null, liquidations: null, holders: null };
const issuedAt = 601_500;
const flow = { buyUsdt: 80_000, sellUsdt: 20_000, largeBuyUsdt: 50_000, largeSellUsdt: 0, largeThresholdUsdt: 10_000 };
const interest = { change: 2, time: 600_000 };

test("identifies unusual filled trade clusters by taker side and relative notional", () => {
  const trades = [1000, 2000, 2000, 2000, 20_000, 30_000].map((amount, id) => ({
    id, time: issuedAt - 1_000 + id, amount, side: id % 2 ? "sell" : "buy",
  }));
  const amounts = sumShortVolume(trades, issuedAt, null).find(({ period }) => period === "1m").amounts;
  assert.equal(summarizeTradePressure(trades.slice(0, 4), amounts), null);
  const pressure = summarizeTradePressure(trades, amounts);
  assert.deepEqual(pressure, { buyUsdt: 23_000, sellUsdt: 34_000, largeBuyUsdt: 20_000,
    largeSellUsdt: 30_000, largeThresholdUsdt: 16_000 });
  assert.equal(largeTradeSide(pressure), "sell");
  assert.equal(largeTradeSide({ ...pressure, largeBuyUsdt: 30_000 }), "mixed");
  assert.equal(largeTradeSide({ ...pressure, largeSellUsdt: 0 }), "buy");
  assert.equal(largeTradeSide({ ...pressure, largeBuyUsdt: 0, largeSellUsdt: 0 }), "none");
});

test("uses the last adjacent five-minute OI points at or before the alert", () => {
  const rows = [
    { timestamp: 900_000, sumOpenInterest: "5000" },
    { timestamp: 600_000, sumOpenInterest: "120" },
    { timestamp: 300_000, sumOpenInterest: "100" },
  ];
  const result = latestOpenInterestChange(normalizeOpenInterest(rows), issuedAt);
  assert.equal(result.time, 600_000);
  assert(Math.abs(result.change - 20) < 1e-9);
  assert.equal(latestOpenInterestChange(normalizeOpenInterest(rows.slice(0, 2)), issuedAt), null);
  assert.equal(latestOpenInterestChange(normalizeOpenInterest(rows), 1_500_001), null);
});

test("summarizes near-mid depth and nearby modeled liquidation pressure", () => {
  const book = { bids: [[99.9, 3], [99, 500]], asks: [[100.1, 2], [101, 500]], time: issuedAt };
  const depth = summarizeDepthNearMid(book, 0.005);
  assert.equal(depth.bidUsdt, 99.9 * 3);
  assert.equal(depth.askUsdt, 100.1 * 2);
  const levels = [
    { distancePercent: -2, side: "long", estimatedLiquidationUsdt: 1000 },
    { distancePercent: 1.8, side: "short", estimatedLiquidationUsdt: 3000 },
    { distancePercent: 2.1, side: "short", estimatedLiquidationUsdt: 9000 },
  ];
  assert.equal(groupLiquidationTable(levels, 100, "long", [0, 2])[0].estimatedLiquidationUsdt, 1000);
  assert.equal(groupLiquidationTable(levels, 100, "short", [0, 2])[0].estimatedLiquidationUsdt, 3000);
});

test("forecasts both directions, abstains on weak or contradictory flow, and uses holders for amplitude", () => {
  assert.equal(forecastSpike({ ...empty, flow }, 5, 100, issuedAt), null);
  assert.equal(forecastSpike({ ...empty, interest }, 5, 100, issuedAt), null);
  const positive = forecastSpike({ ...empty, flow, interest }, -5, 100, issuedAt);
  assert(positive.change > 0);
  assert.equal(positive.settlesAt, 960_000);
  const withHolders = forecastSpike({ ...empty, flow, interest, holders: { percentage: 50, count: 200, time: issuedAt } }, -5, 100, issuedAt);
  assert(withHolders.change > positive.change);
  const selling = { ...flow, buyUsdt: 20_000, sellUsdt: 80_000, largeBuyUsdt: 0, largeSellUsdt: 50_000 };
  assert(forecastSpike({ ...empty, flow: selling, interest }, 5, 100, issuedAt).change < 0);
  const weak = { ...flow, buyUsdt: 49_000, sellUsdt: 51_000, largeBuyUsdt: 0 };
  assert.equal(forecastSpike({ ...empty, flow: weak, interest }, 5, 100, issuedAt), null);
  assert.equal(forecastSpike({ ...empty, flow: weak, depth: { bidUsdt: 990, askUsdt: 10, time: issuedAt } }, 5, 100, issuedAt), null);
});

test("settles against the exact closed candle and scores only comparable outcomes", () => {
  const forecast = { price: 100, change: 2, issuedAt, settlesAt: 960_000 };
  const target = [900_000, "100", "104", "99", "103", "5000", 959_999];
  const other = [960_000, "103", "105", "101", "104", "5000", 1_019_999];
  assert.equal(readForecastClose([other], forecast.settlesAt), null);
  assert.equal(readForecastClose([[...target.slice(0, 6), 959_998]], forecast.settlesAt), null);
  const outcome = readForecastClose([other, target], forecast.settlesAt);
  assert.deepEqual(outcome, { price: 103, time: 959_999 });
  const comparison = compareForecast(forecast, outcome);
  assert(comparison.hit && Math.abs(comparison.error - 1) < 1e-9);
  const record = { symbol: "TESTUSDT", time: issuedAt, change: -5, analysis: { indicators: empty, forecast } };
  assert.deepEqual(forecastAccuracy([record]), { hits: 0, samples: 0, mae: null });
  const stats = forecastAccuracy([record, { ...record, outcome: null }, { ...record, outcome },
    { ...record, outcome: { ...outcome, price: 98 } }, { ...record, outcome: { ...outcome, price: 100 } }]);
  assert.deepEqual([stats.hits, stats.samples], [1, 3]);
  assert(Math.abs(stats.mae - 7 / 3) < 1e-9);
});

test("alert momentum produces a settleable fallback even when indicators or their request fail", () => {
  const fallback = forecastAlertMove(-5, 100, issuedAt);
  assert.deepEqual(fallback, { change: -1, price: 100, issuedAt, settlesAt: 960_000 });
  assert.equal(forecastAlertMove(5, 100, issuedAt).change, 1);
  assert.equal(estimateAlertMove(30), 3);
  assert.equal(estimateAlertMove(-0.01), -0.05);
  assert.equal(estimateAlertMove(0), null);
  assert.equal(forecastAlertMove(-5, 0, issuedAt), undefined);
  const record = { symbol: "TESTUSDT", time: issuedAt, change: -5, fallback };
  assert.equal(getRecordForecast(record), fallback);
  assert.equal(getRecordForecast({ ...record, analysis: null }), fallback);
  assert.equal(getRecordForecast({ ...record, analysis: { indicators: empty, forecast: null } }), fallback);
  const forecast = forecastSpike({ ...empty, flow, interest }, -5, 102, issuedAt + 1000);
  assert.equal(getRecordForecast({ ...record, analysis: { indicators: empty, forecast } }), forecast);
  const outcome = { price: 99, time: fallback.settlesAt - 1 };
  const stats = forecastAccuracy([{ ...record, outcome }, { ...record, fallback: undefined, outcome }]);
  assert.deepEqual([stats.hits, stats.samples], [1, 1]);
  assert(stats.mae < 1e-9);
});
