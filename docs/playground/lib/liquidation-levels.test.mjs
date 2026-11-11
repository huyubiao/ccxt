import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateLiquidationLevels, getLeverageWeighting, groupLiquidationTable, replayLiquidations, selectLiquidationSpikes, selectMarketCapHistory, MARKET_CAP_DAY_MS as day, LIQUIDATION_INTERVAL_MS as step } from "./liquidation-levels.ts";

const bar = (time, low = 99, high = 101) => ({ time, low, high, close: 100 });
const point = (time, quantity) => ({ time, quantity });

test("open interest growth produces ranked levels on both sides of the mark", () => {
  const snapshot = estimateLiquidationLevels("JCTUSDT", [point(step, 0), point(2 * step, 30)],
    [bar(0), bar(step)], 100, 2 * step);
  assert.equal(snapshot.model, "open-interest-weighted-leverage");
  assert.deepEqual(snapshot.leverageScenarios, [1, 2, 3, 5, 10, 20]);
  assert.equal(snapshot.levels[0].strength, 100);
  assert.equal(snapshot.coverage.openInterestQuantity, 30);
  for (const side of ["long", "short"]) {
    const bands = snapshot.levels.filter((band) => band.side === side);
    assert.ok(bands.length > 5);
    const quantity = bands.reduce((sum, band) => sum + band.estimatedLiquidationUsdt / band.price, 0);
    const positiveShare = snapshot.leverageWeighting.weights.reduce((sum, weight) => sum + weight[side] *
      snapshot.marginScenarios.filter((scenario) => side === "short" || 1 + scenario.extraInitialMarginFraction < weight.leverage)
        .reduce((share, scenario) => share + scenario[side], 0), 0);
    assert.ok(bands.every(({ price, estimatedLiquidationUsdt }) => price > 0 && estimatedLiquidationUsdt > 0));
    assert.ok(Math.abs(quantity - 30 * positiveShare) < 1e-9);
    assert.ok(Math.abs(snapshot.coverage[`${side}Quantity`] - quantity) < 1e-9);
  }
});

test("initial open interest contributes levels and can liquidate with no net change", () => {
  const points = [point(step, 1000), point(2 * step, 1000)];
  const initialBar = bar(0, 100, 100);
  const snapshot = estimateLiquidationLevels("ETHUSDT", points, [initialBar, bar(step)], 100, 2 * step);
  assert.ok(snapshot.coverage.longQuantity > 0);
  assert.ok(Math.abs(snapshot.coverage.shortQuantity - 1000) < 1e-9);
  const replay = replayLiquidations("ETHUSDT", points, [initialBar, bar(step, 94, 106)], step, step, 2 * step, null, null);
  assert.ok(replay.long > 0 && replay.short > 0);

  const flat = estimateLiquidationLevels("ETHUSDT", [point(step, 0), point(2 * step, 0)],
    [initialBar, bar(step)], 100, 2 * step);
  assert.deepEqual(flat.levels, []);
  assert.deepEqual(flat.coverage, { openInterestQuantity: 0, longQuantity: 0, shortQuantity: 0 });
});

test("turnover replaces old exposure at the new price without increasing open interest", () => {
  const points = [point(step, 1000), point(2 * step, 1000), point(3 * step, 1000)];
  const prior = bar(0, 100, 100);
  const moved = { time: step, low: 100, high: 101, close: 101, volume: 200 };
  const snapshot = estimateLiquidationLevels("ETHUSDT", points.slice(0, 2), [prior, moved], 101, 2 * step);
  assert.ok(Math.abs(snapshot.coverage.shortQuantity - 1000) < 1e-9);
  assert.ok(snapshot.levels.some(({ price }) => Math.abs(price - 404) < 1e-9));
  const replay = replayLiquidations("ETHUSDT", points, [prior, moved, bar(2 * step)], step, step, 3 * step, null, null);
  assert.equal(replay.intervals[0].replacementMax, 100);
  assert.equal(replay.intervals[0].replacedQuantity, 10);
  assert.equal(replay.intervals[1].replacementMax, null);
  assert.equal(replay.intervals[1].replacedQuantity, 0);
});

test("replacement cannot use the volume already needed for net changes or exceed remaining interest", () => {
  const points = [point(step, 1000), point(2 * step, 1100), point(3 * step, 10), point(4 * step, 0)];
  const bars = [bar(0), { ...bar(step), volume: 100 }, { ...bar(2 * step), volume: 9000 }, { ...bar(3 * step), volume: 100 }];
  const replay = replayLiquidations("ETHUSDT", points, bars, step, step, 4 * step, null, null);
  assert.deepEqual(replay.intervals.map(({ replacementMax, replacedQuantity }) => [replacementMax, replacedQuantity]),
    [[0, 0], [10, 1], [0, 0]]);
  const snapshot = estimateLiquidationLevels("ETHUSDT", points, bars, 100, 4 * step);
  assert.deepEqual(snapshot.levels, []);
});

test("levels crossed after formation disappear even if the mark returns", () => {
  const points = [point(step, 0), point(2 * step, 30), point(3 * step, 25)];
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
  const snapshot = estimateLiquidationLevels("BTCUSDT", [point(step, 0), point(2 * step, 100)],
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
  const snapshot = estimateLiquidationLevels("ETHUSDT", [point(step, 0), point(2 * step, 100)],
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
    const points = [point(step, 0), point(2 * step, 100), point(3 * step, 110)];
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
  const snapshot = estimateLiquidationLevels("ETHUSDT", [point(step, 0), point(2 * step, 100), point(3 * step, 110)],
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
  const levels = [level("long", -1, 10), level("long", -4, 20), level("long", -80, 30), level("long", -81, 100),
    level("short", 2, 40), level("short", 5, 50), level("short", 300, 60), level("short", 301, 100)];
  const long = groupLiquidationTable(levels, 100, "long");
  const short = groupLiquidationTable(levels, 100, "short");
  assert.equal(long.length, 9);
  assert.equal(short.length, 10);
  assert.equal(long[0].lowerDistance, -80);
  assert.equal(long[0].lowerPrice, 20);
  assert.equal(short[0].upperDistance, 300);
  assert.equal(short[0].upperPrice, 400);
  assert.deepEqual([long[0].cumulativeEstimatedLiquidationUsdt, short[0].cumulativeEstimatedLiquidationUsdt], [60, 150]);
  assert.deepEqual([long.at(-1).estimatedLiquidationUsdt, short.at(-1).estimatedLiquidationUsdt,
    short.at(-2).estimatedLiquidationUsdt], [30, 40, 50]);
});

test("spikes pick large local concentrations on each side without skipping empty neighboring buckets", () => {
  const band = (side, offset, estimatedLiquidationUsdt) => ({
    side, estimatedLiquidationUsdt,
    lowerPrice: side === "long" ? 100 - (offset + 1) * 0.5 : 100 + offset * 0.5,
    upperPrice: side === "long" ? 100 - offset * 0.5 : 100 + (offset + 1) * 0.5,
  });
  const longPeak = band("long", 0, 1000);
  const shortPeak = band("short", 3, 40);
  const levels = [band("short", 8, 4), band("short", 5, 20), longPeak, band("long", 1, 160),
    band("short", 1, 20), shortPeak, band("short", 2, 20), band("short", 4, 20), band("long", 2, 160),
    band("long", 7, 180), band("short", 13, 15), band("short", 16, 15), band("short", 19, 15)];
  assert.deepEqual(selectLiquidationSpikes(levels, 100, 0.5),
    [longPeak, shortPeak, ...levels.slice(-3)]);
});

test("an empty snapshot and a smooth same-side run have no spikes", () => {
  assert.deepEqual(selectLiquidationSpikes([], 100, 0.5), []);
  const levels = Array.from({ length: 6 }, (_, i) => ({
    side: "long", lowerPrice: 100 - (i + 1) * 0.5, upperPrice: 100 - i * 0.5, estimatedLiquidationUsdt: 20,
  }));
  assert.deepEqual(selectLiquidationSpikes(levels, 100, 0.5), []);
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

test("replay retains a position older than 24 hours and reports its first touch in the correct interval", () => {
  const from = 2 * day;
  const to = from + 2 * step;
  const points = Array.from({ length: to / step + 1 }, (_, index) => point(index * step, index ? 200 : 100));
  const bars = points.slice(0, -1).map(({ time }) => time < from ? bar(time) : bar(time, 99, 106));
  const result = replayLiquidations("TESTUSDT", points, bars, 0, from, to, null, null);
  assert.equal(result.intervals.length, 2);
  assert.ok(result.short > 0);
  assert.equal(result.intervals[0].short, result.short);
  assert.equal(result.intervals[1].short, 0);
  assert.equal(result.intervals[0].time, from);
});

test("maintenance deduction is applied when the trigger falls in a higher notional bracket", () => {
  const profile = { maxLeverage: 20, maintenanceRate: 0.01, notionalCap: 1_000, brackets: [
    { floor: 0, cap: 1_000, maxLeverage: 20, rate: 0.01, deduction: 0 },
    { floor: 1_000, cap: 10_000, maxLeverage: 20, rate: 0.02, deduction: 10 },
  ] };
  const points = [point(0, 100), point(step, 200), point(2 * step, 200)];
  const bars = [bar(0), bar(step, 96.4, 101)];
  const firstOnly = replayLiquidations("TESTUSDT", points, bars, 0, step, 2 * step, null, null, { ...profile, brackets: undefined });
  const allBrackets = replayLiquidations("TESTUSDT", points, bars, 0, step, 2 * step, null, null, profile);
  assert.equal(firstOnly.long, 0);
  const weight = getLeverageWeighting("TESTUSDT", null, null, profile).weights.find(({ leverage }) => leverage === 20);
  const trigger = 100 * (1 - 1 / 20 - 10 / 2000) / (1 - 0.02);
  assert.ok(Math.abs(allBrackets.long - 100 * weight.long * 0.35 * trigger) < 1e-9);
});

test("reduced margin buffer can trigger both sides on small moves and never creates volume on flat prices", () => {
  const profile = { maxLeverage: 75, maintenanceRate: 0.005, notionalCap: 10_000 };
  const points = [point(0, 100), point(step, 200), point(2 * step, 200)];
  const snapshot = estimateLiquidationLevels("BNBUSDT", [point(step, 100), point(2 * step, 200)],
    [bar(0, 100, 100), bar(step, 100, 100)], 100, 2 * step, null, null, profile);
  const stress = snapshot.reducedMarginBuffer;
  const weight = snapshot.leverageWeighting.weights.find(({ leverage }) => leverage === 75);
  const result = replayLiquidations("BNBUSDT", points, [bar(0), bar(step, 99.75, 100.25)], 0, step, 2 * step, null, null, profile);
  const longTrigger = 100 + (100 * (1 - 1 / 75) / (1 - 0.005) - 100) * stress.remainingDistance;
  const shortTrigger = 100 + (100 * (1 + 1 / 75) / (1 + 0.005) - 100) * stress.remainingDistance;
  assert.ok(Math.abs(result.long - 100 * weight.long * 0.35 * stress.shareOfUnaugmented * longTrigger) < 1e-9);
  assert.ok(Math.abs(result.short - 100 * weight.short * 0.15 * stress.shareOfUnaugmented * shortTrigger) < 1e-9);
  assert.equal(replayLiquidations("BNBUSDT", points, [bar(0), bar(step, 100, 100)], 0, step, 2 * step, null, null, profile).total, 0);
});

