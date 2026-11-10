import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateLiquidationLevels, getLeverageWeighting, groupLiquidationTable, replayLiquidations, selectMarketCapHistory, MARKET_CAP_DAY_MS as day, LIQUIDATION_INTERVAL_MS as step } from "./liquidation-levels.ts";

const bar = (time, low = 99, high = 101) => ({ time, low, high, close: 100 });
const point = (time, quantity) => ({ time, quantity });

test("open interest growth produces ranked levels on both sides of the mark", () => {
  const snapshot = estimateLiquidationLevels("JCTUSDT", [point(step, 100), point(2 * step, 130)],
    [bar(0), bar(step)], 100, 2 * step);
  assert.equal(snapshot.model, "open-interest-weighted-leverage");
  assert.deepEqual(snapshot.leverageScenarios, [1, 2, 3, 5, 10, 20]);
  assert.equal(snapshot.levels[0].strength, 100);
  for (const side of ["long", "short"]) {
    const bands = snapshot.levels.filter((band) => band.side === side);
    assert.ok(bands.length > 5);
    const quantity = bands.reduce((sum, band) => sum + band.estimatedLiquidationUsdt / band.price, 0);
    const positiveShare = snapshot.leverageWeighting.weights.reduce((sum, weight) => sum + weight[side] *
      snapshot.marginScenarios.filter((scenario) => side === "short" || 1 + scenario.extraInitialMarginFraction < weight.leverage)
        .reduce((share, scenario) => share + scenario[side], 0), 0);
    assert.ok(bands.every(({ price, estimatedLiquidationUsdt }) => price > 0 && estimatedLiquidationUsdt > 0));
    assert.ok(Math.abs(quantity - 30 * positiveShare) < 1e-9);
  }
});

test("levels crossed after formation disappear even if the mark returns", () => {
  const points = [point(step, 100), point(2 * step, 130), point(3 * step, 125)];
  const snapshot = estimateLiquidationLevels("JCTUSDT", points, [bar(0), bar(step), bar(2 * step, 94, 106)], 100, 3 * step);
  assert.ok(snapshot.levels.every(({ price, side }) => side === "long" ? price < 94 : price > 106));
  assert.ok(snapshot.levels.some(({ price }) => Math.abs(price - 93.75) < 1e-9));
  assert.ok(snapshot.levels.some(({ price }) => Math.abs(price - 106.25) < 1e-9));
});

test("BTC splits its 20x budget into higher tiers without adding position quantity", () => {
  const weighting = getLeverageWeighting("BTCUSDT");
  assert.equal(weighting.marketCapBand.label, "稳定");
  assert.deepEqual(weighting.weights.find(({ leverage }) => leverage === 10), { leverage: 10, long: 0.10, short: 0.05, maintenanceRate: 0 });
  const high = weighting.weights.filter(({ leverage }) => leverage >= 20);
  assert.deepEqual(high.map(({ leverage }) => leverage), [20, 50, 75, 100]);
  for (const [side, total] of [["long", 0.05], ["short", 0.03]]) {
    assert.ok(Math.abs(high.reduce((sum, row) => sum + row[side], 0) - total) < 1e-9);
    assert.ok(high.every((row) => row[side] > 0));
  }
});

test("1x is weighted on both sides and only produces positive levels for shorts", () => {
  const snapshot = estimateLiquidationLevels("BTCUSDT", [point(step, 100), point(2 * step, 200)],
    [bar(0), bar(step)], 100, 2 * step);
  const { long, short } = snapshot.leverageWeighting.weights.find(({ leverage }) => leverage === 1);
  assert.ok(short > long && long > 0);
  const lowCap = getLeverageWeighting("INITUSDT").weights.find(({ leverage }) => leverage === 1);
  assert.ok(lowCap.long > long && lowCap.short > short);
  const shortWithExtraMargin = snapshot.levels.find((band) => band.side === "short" && Math.abs(band.price - 400) < 1e-9);
  assert.ok(shortWithExtraMargin);
  assert.ok(Math.abs(shortWithExtraMargin.estimatedLiquidationUsdt / shortWithExtraMargin.price - 100 * short * 0.15) < 1e-9);
  assert.ok(snapshot.levels.every(({ price }) => price > 0));
});

test("added margin moves the same leverage allocation away from entry on both sides", () => {
  const snapshot = estimateLiquidationLevels("ETHUSDT", [point(step, 100), point(2 * step, 200)],
    [bar(0), bar(step)], 100, 2 * step);
  assert.deepEqual(snapshot.marginScenarios.map(({ extraInitialMarginFraction, long, short }) => [extraInitialMarginFraction, long, short]), [
    [0, 0.35, 0.15], [0.25, 0.25, 0.20], [0.50, 0.20, 0.25], [1, 0.15, 0.25], [2, 0.05, 0.15],
  ]);
  for (const [side, direction, allocated] of [["short", 1, 3], ["long", -1, 5]]) {
    for (const { extraInitialMarginFraction, [side]: share } of snapshot.marginScenarios.slice(0, 3)) {
      const distance = 5 * (1 + extraInitialMarginFraction);
      const target = 100 + direction * distance;
      const level = snapshot.levels.find((band) => band.side === side && Math.abs(band.price - target) < 1e-9);
      assert.ok(level, `expected ${side} band at ${target}`);
      assert.ok(Math.abs(level.estimatedLiquidationUsdt - allocated * share * target) < 1e-9);
    }
  }
});

test("adverse-price adds move surviving long and short levels away without counting their size twice", () => {
  for (const [side, close, oldPrice, expectedPrice, originalQuantity] of [
    ["long", 97.5, 95, 94.525, 1.75], ["short", 102.5, 105, 105.525, 0.45],
  ]) {
    const points = [point(step, 100), point(2 * step, 200), point(3 * step, 210)];
    const secondBar = { time: 2 * step, low: Math.min(100, close), high: Math.max(100, close), close };
    const snapshot = estimateLiquidationLevels("ETHUSDT", points, [bar(0), bar(step), secondBar], close, 3 * step);
    const bands = snapshot.levels.filter((band) => band.side === side);
    const moved = bands.find(({ price }) => Math.abs(price - expectedPrice) < 1e-9);
    assert.ok(moved, `expected ${side} level to move to ${expectedPrice}`);
    assert.ok(Math.abs(moved.estimatedLiquidationUsdt / moved.price - originalQuantity * 1.25) < 1e-9);
    assert.ok(!bands.some(({ price }) => Math.abs(price - oldPrice) < 1e-9));
    const shortQuantity = snapshot.levels.filter((band) => band.side === "short")
      .reduce((sum, band) => sum + band.estimatedLiquidationUsdt / band.price, 0);
    assert.ok(Math.abs(shortQuantity - 110) < 1e-9);
  }
});

test("an add at the close cannot rescue a cohort already crossed during the bar", () => {
  const snapshot = estimateLiquidationLevels("ETHUSDT", [point(step, 100), point(2 * step, 200), point(3 * step, 210)],
    [bar(0), bar(step), { time: 2 * step, low: 100, high: 105.1, close: 102.5 }], 102.5, 3 * step);
  const shortQuantity = snapshot.levels.filter((band) => band.side === "short")
    .reduce((sum, band) => sum + band.estimatedLiquidationUsdt / band.price, 0);
  assert.ok(Math.abs(shortQuantity - (110 - 0.45)) < 1e-9);
});

test("small-cap weights place most notional below 5x and missing data uses a distinct fallback", () => {
  const weighting = getLeverageWeighting("TESTUSDT", {
    medianUsd: 30_000_000, source: "coingecko", windowDays: 180, samples: 175, through: 0,
  });
  assert.equal(weighting.marketCapBand.label, "很高风险");
  for (const side of ["long", "short"]) {
    assert.ok(weighting.weights.filter(({ leverage }) => leverage < 5).reduce((sum, weight) => sum + weight[side], 0) > 0.8);
    assert.ok(Math.abs(weighting.weights.reduce((sum, weight) => sum + weight[side], 0) - 1) < 1e-9);
  }
  assert.equal(getLeverageWeighting("TESTUSDT").marketCapBand.source, "fallback");
});

test("market cap history chooses the longest complete window and excludes current-day partial data", () => {
  const end = 500 * day;
  const rows = (days) => Array.from({ length: days }, (_, i) => [end - i * day, i + 1]);
  for (const [available, selected] of [[360, 360], [359, 180], [179, 60], [59, 30]]) {
    const snapshot = selectMarketCapHistory([...rows(available), [end + 1, 1e9]], "coingecko", end + 1, 0);
    assert.equal(snapshot.windowDays, selected);
    assert.equal(snapshot.samples, selected);
    assert.equal(snapshot.medianUsd, (selected + 1) / 2);
  }
  assert.equal(selectMarketCapHistory(rows(29), "coingecko", end, end - 365 * day), null);
  const short = selectMarketCapHistory(rows(7).filter((_, i) => i !== 2), "coingecko", end, end - 8 * day);
  assert.equal(short.samples, 6);
  assert.equal(short.windowDays, 7);
  assert.equal(selectMarketCapHistory(rows(360).filter((_, i) => i !== 45), "coingecko", end, 0).windowDays, 30);
});

test("all 42 cap and turnover combinations use normalized distinct weights", () => {
  const combinations = new Set();
  const caps = [19_999_999, 20_000_000, 60_000_000, 200_000_000, 1_000_000_000, 5_000_000_000, 30_000_000_000];
  const ratios = [0.175, 0.25, 0.50, 1, 2, 2.01];
  for (const [capIndex, medianUsd] of caps.entries()) {
    const cap = { medianUsd, source: "coingecko", windowDays: 360, samples: 360, through: 0 };
    let previousLong20 = 1;
    for (const [turnoverIndex, ratio] of ratios.entries()) {
      const result = getLeverageWeighting("BTCUSDT", cap, { volumeUsdt: ratio * 1e8, marketCapUsd: 1e8 });
      assert.equal(result.marketCapBand.index, capIndex);
      assert.equal(result.turnover.band.index, turnoverIndex);
      const long20 = result.weights.find(({ leverage }) => leverage === 20).long;
      assert.ok(long20 < previousLong20);
      previousLong20 = long20;
      for (const side of ["long", "short"]) {
        assert.ok(Math.abs(result.weights.reduce((sum, row) => sum + row[side], 0) - 1) < 1e-9);
      }
      combinations.add(JSON.stringify(result.weights));
    }
  }
  assert.equal(combinations.size, 42);
});

test("cumulative amounts start at the mark and stay on their own side", () => {
  const snapshot = estimateLiquidationLevels("JCTUSDT", [point(step, 100), point(2 * step, 130)],
    [bar(0), bar(step)], 100, 2 * step);
  for (const side of ["long", "short"]) {
    const bands = snapshot.levels.filter((band) => band.side === side)
      .sort((a, b) => Math.abs(a.distancePercent) - Math.abs(b.distancePercent));
    let expected = 0;
    for (const band of bands) {
      expected += band.estimatedLiquidationUsdt;
      assert.equal(band.cumulativeEstimatedLiquidationUsdt, expected);
    }
  }
});

test("missing samples fail rather than appearing as a market without pressure", () => {
  assert.throws(() => estimateLiquidationLevels("JCTUSDT", [point(step, 100), point(3 * step, 200)],
    [bar(0), bar(step), bar(2 * step)], 100, 3 * step), /interval is missing/);
});

test("the table keeps both distance endpoints, coalesces bands and accumulates outward", () => {
  const level = (side, distancePercent, estimatedLiquidationUsdt) => ({ side, distancePercent, estimatedLiquidationUsdt });
  const levels = [level("long", -1, 10), level("long", -4, 20), level("long", -95, 30), level("long", -96, 100),
    level("short", 2, 40), level("short", 5, 50), level("short", 1000, 60), level("short", 1001, 100)];
  const long = groupLiquidationTable(levels, 100, "long");
  const short = groupLiquidationTable(levels, 100, "short");
  assert.equal(long.length, 11);
  assert.equal(short.length, 13);
  assert.equal(long[0].lowerDistance, -95);
  assert.equal(long[0].lowerPrice, 5);
  assert.equal(short[0].upperDistance, 1000);
  assert.equal(short[0].upperPrice, 1100);
  assert.deepEqual([long[0].cumulativeEstimatedLiquidationUsdt, short[0].cumulativeEstimatedLiquidationUsdt], [60, 150]);
  assert.deepEqual([long.at(-1).estimatedLiquidationUsdt, short.at(-1).estimatedLiquidationUsdt,
    short.at(-2).estimatedLiquidationUsdt], [30, 40, 50]);
});

test("BTC replay catches both sides on a two-percent move", () => {
  const points = [point(0, 100), point(step, 200), point(2 * step, 200)];
  const bars = [bar(0), bar(step, 97.9, 102.1)];
  const btc = replayLiquidations("BTCUSDT", points, bars, 0, step, 2 * step, null, null);
  assert.ok(btc.long > 0 && btc.short > 0);
  assert.equal(replayLiquidations("ETHUSDT", points, bars, 0, step, 2 * step, null, null).total, 0);
});

test("high-leverage small-position margin tiers trigger on smaller moves without adding CAKE quantity", () => {
  const cake = getLeverageWeighting("CAKEUSDT").weights.filter(({ leverage }) => leverage >= 20);
  const baseline = getLeverageWeighting("TESTUSDT").weights.find(({ leverage }) => leverage === 20);
  assert.deepEqual(cake.map(({ leverage }) => leverage), [20, 50, 75]);
  for (const side of ["long", "short"]) {
    assert.ok(Math.abs(cake.reduce((sum, row) => sum + row[side], 0) - baseline[side]) < 1e-9);
  }
  const points = [point(0, 100), point(step, 200), point(2 * step, 200)];
  const bars = [bar(0), bar(step, 99.3, 100.7)];
  for (const symbol of ["CAKEUSDT", "BTCUSDT"]) {
    const result = replayLiquidations(symbol, points, bars, 0, step, 2 * step, null, null);
    assert.ok(result.long > 0 && result.short > 0);
  }
  assert.equal(replayLiquidations("TESTUSDT", points, bars, 0, step, 2 * step, null, null).total, 0);
});

test("replay counts the first touch of each cohort only in the selected window", () => {
  const points = [point(0, 100), point(step, 200), point(2 * step, 200), point(3 * step, 200)];
  const bars = [bar(0), bar(step, 99, 105.1), bar(2 * step, 99, 105.1)];
  const result = replayLiquidations("ETHUSDT", points, bars, 0, step, 3 * step, null, null);
  assert.equal(result.long, 0);
  assert.ok(Math.abs(result.short - (100 * 0.03 * 0.15 * 105)) < 1e-9);
  assert.equal(replayLiquidations("ETHUSDT", points, bars, 0, 2 * step, 3 * step, null, null).total, 0);
  assert.throws(() => replayLiquidations("ETHUSDT", points, bars.slice(1), 0, step, 3 * step, null, null), /interval is missing/);
});

test("exchange margin data enables higher tiers for any symbol and caps lower-limit markets", () => {
  const profile = { maxLeverage: 125, maintenanceRate: 0.004, notionalCap: 50_000 };
  const points = [point(0, 100), point(step, 200), point(2 * step, 200)];
  const bars = [bar(0), bar(step, 99.5, 100.5)];
  const result = replayLiquidations("ETHUSDT", points, bars, 0, step, 2 * step, null, null, profile);
  assert.ok(result.long > 0 && result.short > 0);
  assert.equal(replayLiquidations("ETHUSDT", points, [bar(0), bar(step, 100, 100)], 0, step, 2 * step, null, null, profile).total, 0);
  const capped = getLeverageWeighting("TESTUSDT", null, null, { ...profile, maxLeverage: 7 });
  assert.deepEqual(capped.weights.map(({ leverage }) => leverage), [1, 2, 3, 5, 7]);
  for (const side of ["long", "short"]) {
    assert.ok(Math.abs(capped.weights.reduce((sum, weight) => sum + weight[side], 0) - 1) < 1e-9);
  }
});

