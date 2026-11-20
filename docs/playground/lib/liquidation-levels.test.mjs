import assert from "node:assert/strict";
import { test } from "node:test";
import { allocatePositionExits, estimateLiquidationLevels, getLeverageWeighting, groupLiquidationTable, replayLiquidations, replayLiquidationsAsync,
  LiquidationHistoryIncompleteError, requireLiquidationHistory,
  BINANCE_LIQUIDATION_CALIBRATION as calibration,
  selectLargeLiquidationZones, selectMarketCapHistory, MARKET_CAP_DAY_MS as day,
  LIQUIDATION_BACKTEST_MS, LIQUIDATION_POSITION_HISTORY_MS, LIQUIDATION_INTERVAL_MS as step } from "./liquidation-levels.ts";

const bar = (time, low = 99, high = 101) => ({ time, low, high, close: 100 });
const point = (time, quantity) => ({ time, quantity });

test("async replay yields to pending I/O and exactly matches every synchronous interval", async () => {
  const points = Array.from({ length: 161 }, (_, index) => point(index * step, 1000 + index % 7 * 20));
  const bars = points.slice(0, -1).map(({ time }, index) => ({
    time, open: 100, low: 99, high: 101, close: 100 + index % 3 * 0.1, volume: 200,
  }));
  const expected = replayLiquidations("BTCUSDT", points, bars, 0, 20 * step, 160 * step, null);
  let ran = false;
  setTimeout(() => { ran = true; }, 0);
  const actual = await replayLiquidationsAsync("BTCUSDT", points, bars, 0, 20 * step, 160 * step, null);
  assert.equal(ran, true);
  assert.deepEqual(actual, expected);
  await assert.rejects(replayLiquidationsAsync("BTCUSDT", points, bars.slice(1), 0, step, 160 * step, null), /interval is missing/);
});

test("replay uses the pre-event risk chart and ignores subsequent mark candles and open interest", async () => {
  const target = 23 * step;
  const issuedAt = target - step;
  const points = Array.from({ length: 31 }, (_, index) => point(index * step, index ? 1_000 : 10));
  const bars = points.slice(0, -1).map(({ time }) => ({ ...bar(time), open: 100, volume: 0 }));
  const replay = (interest, candles) => replayLiquidationsAsync("TESTUSDT", interest, candles, 0, 20 * step,
    30 * step, null, null, undefined, true);
  const original = await replay(points, bars);
  const changed = await replay(points.map((item) => item.time >= target ? { ...item, quantity: 2_000 } : item),
    bars.map((item) => item.time >= issuedAt ? { ...item, high: 140, low: 60 } : item));
  const before = original.riskSnapshots.find(({ time }) => time === target);
  assert.equal(before.asOf, issuedAt);
  const chart = estimateLiquidationLevels("TESTUSDT", points, bars.filter(({ time }) => time < issuedAt), 100, issuedAt);
  const expected = chart.levels.filter(({ riskLevel }) => riskLevel === "high" || riskLevel === "extreme")
    .map(({ side, lowerPrice, upperPrice, openInterestShare, riskLevel }) =>
      ({ side, lowerPrice, upperPrice, openInterestShare, riskLevel }));
  assert.ok(expected.length >= 2);
  assert.deepEqual(before.bands, expected);
  assert.deepEqual(changed.riskSnapshots.find(({ time }) => time === target), before);
  assert.notDeepEqual(changed.riskSnapshots.find(({ time }) => time === target + step),
    original.riskSnapshots.find(({ time }) => time === target + step));
});

test("risk bands are 1% wide and include the 3% and 6% thresholds", () => {
  const weights = { id: "risk-boundary", marketCapSlope: 0, volatilitySlope: 0, leveraged: [
    { leverage: 10, long: 0.03, short: 0.06 },
    { leverage: 20, long: 0.0299, short: 0.0599 },
  ] };
  for (const mark of [100, 200]) {
    const data = estimateLiquidationLevels("BTCUSDT", [point(0, 0), point(step, 1_000)],
      [{ time: 0, low: mark, high: mark, close: mark }], mark, step, null, null, weights);
    assert.equal(data.bandWidthPercent, 1);
    assert.ok(data.levels.every((band) => band.upperPrice - band.lowerPrice === mark / 100));
    for (const side of ["long", "short"]) {
      const exactAmount = data.triggers[side].reduce((sum, [price, quantity]) => sum + price * quantity, 0);
      const bandAmount = data.levels.filter((band) => band.side === side)
        .reduce((sum, band) => sum + band.estimatedLiquidationUsdt, 0);
      assert.ok(Math.abs(exactAmount - bandAmount) < 1e-9);
    }
    for (const [side, share, expected] of [
      ["long", 0.03, "high"], ["long", 0.0299, "elevated"], ["short", 0.06, "extreme"], ["short", 0.0599, "high"],
    ]) {
      const band = data.levels.find((level) => level.side === side && Math.abs(level.openInterestShare - share) < 1e-12);
      assert.equal(band?.riskLevel, expected);
    }
  }
});

const position = (side, entry, quantity, marginPerUnit = 10) => ({
  side, entry, quantity, marginPerUnit, accountQuantity: 1, leverage: entry / marginPerUnit,
  maintenanceRate: 0, price: entry + (side === "long" ? -marginPerUnit : marginPerUnit), openedAt: 0,
});

test("net reductions exit profitable positions proportionally before losing positions", () => {
  for (const side of ["long", "short"]) {
    const profitEntry = side === "long" ? 90 : 110;
    const lossEntry = side === "long" ? 102 : 98;
    const positions = [position(side, profitEntry, 5), position(side, profitEntry, 20), position(side, lossEntry, 30)];
    allocatePositionExits(positions, side, 100, 55, 10, 0);
    assert.deepEqual(positions.map(({ quantity }) => quantity), [3, 12, 30]);
    assert.equal(positions[1].entry, profitEntry);
  }
});

test("the main exit share starts with the position closest to break-even", () => {
  for (const [side, close] of [["long", 96.5], ["short", 103.5]]) {
    const direction = side === "long" ? 1 : -1;
    const risky = position(side, close + direction, 20, 1.5);
    const flat = position(side, close, 10);
    const largerGain = position(side, close - 4 * direction, 10);
    const smallLoss = position(side, close + 0.75 * direction, 4);
    const smallGain = position(side, close - 0.25 * direction, 5);
    smallGain.openedAt = -step;
    const positions = [risky, flat, largerGain, smallLoss, smallGain];
    allocatePositionExits(positions, side, close, 49, 0, 10);
    assert.deepEqual(positions.map(({ quantity }) => Number(quantity.toFixed(9))), [19.9, 4, 9.1, 4, 2]);
    assert.equal(risky.marginPerUnit, 1.5);
  }
});

test("extra exits split 60/30/9/1 across a single pool of positions", () => {
  for (const side of ["long", "short"]) {
    const direction = side === "long" ? 1 : -1;
    const primary = position(side, 100, 100);
    const lessProfitable = position(side, 100 - 10 * direction, 30);
    lessProfitable.openedAt = -step;
    const profitable = position(side, 100 - 20 * direction, 30);
    const mostProfitable = position(side, 100 - 30 * direction, 30);
    const near = position(side, 100 + 10 * direction, 10, 15);
    const nearer = position(side, 100 + 12 * direction, 20, 15);
    const positions = [primary, lessProfitable, profitable, mostProfitable, near, nearer];
    allocatePositionExits(positions, side, 100, 220, 0, 100);
    assert.deepEqual(positions.map(({ quantity }) => Number(quantity.toFixed(9))), [40, 0, 30, 21, 9.666666667, 19.333333333]);
  }
});

test("the old-stock share replaces unidentified starting positions before the oldest tracked cohort", () => {
  const recent = position("long", 100, 100);
  const oldest = { ...position("long", 102, 30), openedAt: -step };
  const positions = [recent, oldest];
  allocatePositionExits(positions, "long", 100, 135, 0, 100);
  assert.deepEqual(positions.map(({ quantity }) => quantity), [30, 5]);
});

test("exit allocation preserves OI bounds with unknown starting stock, huge volume, and no profitable positions", () => {
  for (const previous of [0, 100, 1000]) {
    for (const requested of [0, 1, previous, previous * 10]) {
      const positions = previous ? [position("short", 100, previous / 4)] : [];
      allocatePositionExits(positions, "short", 100, previous, requested, 0);
      const remaining = positions.reduce((sum, row) => sum + row.quantity, 0);
      assert.ok(remaining >= 0 && remaining <= Math.max(0, previous - requested) + 1e-9);
    }
  }
});

test("price direction favors long exits on rises and short exits on falls while all volume is accounted for", () => {
  for (const change of [-100, 0, 100]) {
    for (const close of [99.9, 100, 100.1]) {
      const points = [point(0, 0), point(step, 1000), point(2 * step, 1000 + change)];
      const bars = [{ ...bar(0, 100, 100), open: 100 }, { time: step, open: 100, high: Math.max(close, 100),
        low: Math.min(close, 100), close, volume: 500 }];
      const replay = replayLiquidations("ETHUSDT", points, bars, 0, step, 2 * step, null);
      const flow = replay.intervals[0].volumeBreakdown;
      assert.ok(Math.abs(flow.doubleOpen + flow.doubleClose + flow.longTurnover + flow.shortTurnover - 500) < 1e-9);
      assert.ok(Math.abs(flow.doubleOpen - flow.doubleClose - change) < 1e-9);
      if (close > 100) assert.ok(flow.longTurnover > flow.shortTurnover);
      if (close < 100) assert.ok(flow.shortTurnover > flow.longTurnover);
      if (close === 100) assert.equal(flow.longTurnover, flow.shortTurnover);
      const snapshot = estimateLiquidationLevels("ETHUSDT", points, bars, close, 2 * step);
      assert.ok(Math.abs(snapshot.coverage.shortQuantity - (1000 + change)) < 1e-9);
      assert.ok(snapshot.coverage.longQuantity <= 1000 + change + 1e-9);
    }
  }
});

test("turnover uses distance as a tie-breaker and leaves near-liquidation positions behind unknown stock", () => {
  const closer = position("long", 100, 10, 10);
  const farther = position("long", 100, 10, 20);
  const near = position("long", 100, 10, 5);
  const positions = [closer, farther, near];
  allocatePositionExits(positions, "long", 97, 50, 0, 12);
  assert.deepEqual(positions.map(({ quantity }) => Number(quantity.toFixed(9))), [10, 1.72, 9.88]);
  allocatePositionExits(positions, "long", 97, 38, 5, 28, 98);
  assert.equal(closer.quantity + farther.quantity, 0);
  assert.ok(Math.abs(near.quantity - 5) < 1e-9);
  assert.equal(near.price, 95);
});

test("open interest growth produces ranked levels on both sides of the mark", () => {
  const snapshot = estimateLiquidationLevels("JCTUSDT", [point(step, 0), point(2 * step, 30)],
    [bar(0), bar(step)], 100, 2 * step);
  assert.equal(snapshot.model, "open-interest-weighted-leverage");
  assert.deepEqual(snapshot.leverageScenarios, [1, 2, 3, 4, 5, 7, 10, 20]);
  assert.equal(snapshot.levels[0].strength, 100);
  assert.equal(snapshot.coverage.openInterestQuantity, 30);
  for (const side of ["long", "short"]) {
    const bands = snapshot.levels.filter((band) => band.side === side);
    assert.equal(bands.length, side === "long" ? 7 : 8);
    const quantity = bands.reduce((sum, band) => sum + band.estimatedLiquidationUsdt / band.price, 0);
    const positiveShare = snapshot.leverageWeighting.weights
      .filter(({ leverage }) => side === "short" || leverage > 1)
      .reduce((sum, weight) => sum + weight[side], 0);
    assert.ok(bands.every(({ price, estimatedLiquidationUsdt }) => price > 0 && estimatedLiquidationUsdt > 0));
    assert.ok(Math.abs(quantity - 30 * positiveShare) < 1e-9);
    assert.ok(Math.abs(snapshot.coverage[`${side}Quantity`] - quantity) < 1e-9);
  }
});

test("initial open interest alone produces neither liquidation levels nor replay triggers", () => {
  const points = [point(step, 1000), point(2 * step, 1000)];
  const initialBar = bar(0, 100, 100);
  const snapshot = estimateLiquidationLevels("ETHUSDT", points, [initialBar, bar(step)], 100, 2 * step);
  assert.deepEqual(snapshot.levels, []);
  assert.deepEqual(snapshot.coverage, { openInterestQuantity: 1000, longQuantity: 0, shortQuantity: 0 });
  const replay = replayLiquidations("ETHUSDT", points, [initialBar, bar(step, 94, 106)], step, step, 2 * step, null);
  assert.equal(replay.total, 0);

  const flat = estimateLiquidationLevels("ETHUSDT", [point(step, 0), point(2 * step, 0)],
    [initialBar, bar(step)], 100, 2 * step);
  assert.deepEqual(flat.levels, []);
  assert.deepEqual(flat.coverage, { openInterestQuantity: 0, longQuantity: 0, shortQuantity: 0 });
});

test("the first interval assigns only net growth or estimated replacements, never the starting stock", () => {
  const snapshot = (end, volume) => estimateLiquidationLevels("ETHUSDT",
    [point(step, 1000), point(2 * step, end)], [bar(0), { ...bar(step), volume }], 100, 2 * step);
  const growth = snapshot(1100, 100);
  assert.equal(growth.coverage.openInterestQuantity, 1100);
  assert.ok(Math.abs(growth.coverage.shortQuantity - 100) < 1e-9);
  assert.ok(growth.coverage.longQuantity > 0 && growth.coverage.longQuantity <= 100);

  const turnover = snapshot(1000, 200);
  assert.equal(turnover.coverage.openInterestQuantity, 1000);
  assert.ok(Math.abs(turnover.coverage.shortQuantity - 1000 * (1 - Math.exp(-0.1))) < 1e-9);
});

test("turnover opens at the trading VWAP while paired replacements use the mark close", () => {
  const points = [point(0, 0), point(step, 1000), point(2 * step, 1000), point(3 * step, 1000)];
  const prior = bar(0, 100, 100);
  const moved = { time: step, low: 98, high: 104, close: 101, volume: 200, turnoverPrice: 104 };
  const snapshot = estimateLiquidationLevels("ETHUSDT", points.slice(0, 3), [bar(-step), prior, moved], 101, 2 * step);
  assert.ok(Math.abs(snapshot.coverage.shortQuantity - 1000) < 1e-9);
  const { weights } = snapshot.leverageWeighting;
  const shortShare = weights.find(({ leverage }) => leverage === 1).short;
  const longShare = weights.find(({ leverage }) => leverage === 2).long;
  const pairedReplacement = 1000 * (1 - Math.exp(-0.05));
  const turnoverReplacement = 1000 * Math.exp(-0.05) * (1 - Math.exp(-0.05));
  for (const [side, price, expectedQuantity] of [
    ["short", 202, pairedReplacement * shortShare],
    ["short", 208, turnoverReplacement * shortShare],
    ["long", 52, turnoverReplacement * longShare],
  ]) {
    const band = snapshot.levels.find((row) => row.side === side && Math.abs(row.price - price) < 1e-9);
    assert.ok(band, `expected ${side} band at ${price}`);
    assert.ok(Math.abs(band.estimatedLiquidationUsdt / band.price - expectedQuantity) < 1e-9,
      `unexpected ${side} quantity at ${price}`);
  }
  const replay = replayLiquidations("ETHUSDT", points, [prior, moved, bar(2 * step)], 0, step, 3 * step, null);
  assert.deepEqual(replay.intervals.map(({ volumeBreakdown }) => volumeBreakdown),
    [{ doubleOpen: 50, doubleClose: 50, longTurnover: 50, shortTurnover: 50 }, null]);
});

test("turnover keeps near-liquidation cohorts live until a later mark-price touch", () => {
  const points = [point(0, 0), point(step, 1000), point(2 * step, 1000), point(3 * step, 1000)];
  const bars = [bar(0, 100, 100), { time: step, low: 95.9, high: 96.01, close: 96, volume: 400, turnoverPrice: 96.001 },
    { ...bar(2 * step, 95, 96), close: 96, volume: 0 }];
  const snapshot = estimateLiquidationLevels("ETHUSDT", points.slice(0, 3), bars.slice(0, 2), 96, 2 * step);
  const nearest = Math.max(...snapshot.levels.filter(({ side }) => side === "long").map(({ price }) => price));
  assert.ok(Math.abs(nearest - 95) < 1e-9);
  const replay = replayLiquidations("ETHUSDT", points, bars, 0, step, 3 * step, null);
  const at20 = 1000 * 0.01;
  assert.equal(replay.intervals[0].long, 0);
  const extraExits = 1000 * -Math.expm1(-0.2);
  assert.ok(Math.abs(replay.intervals[1].long - (at20 - extraExits * 0.01) * 95) < 1e-9);
});

test("a fall to zero open interest closes near-liquidation cohorts without recording an untouched trigger", () => {
  const points = [point(0, 0), point(step, 1000), point(2 * step, 0)];
  const bars = [bar(0, 100, 100), { time: step, low: 96, high: 96, close: 96, volume: 1000 }];
  const replay = replayLiquidations("ETHUSDT", points, bars, 0, step, 2 * step, null);
  assert.equal(replay.long, 0);
  assert.equal(replay.short, 0);
  assert.deepEqual(estimateLiquidationLevels("ETHUSDT", points, bars, 96, 2 * step).levels, []);
});

test("modeled forced exits offset a matching net OI decline on the same side", () => {
  const first = bar(0, 100, 100);
  const second = bar(step, 100, 125);
  const snapshot = (oi, volume) => estimateLiquidationLevels("ETHUSDT", [point(0, 0), point(step, 1000), point(2 * step, oi)],
    [first, { ...second, volume }], 100, 2 * step);
  const survivingShorts = snapshot(1000).coverage.shortQuantity;
  assert.ok(survivingShorts < 1000);
  const withNetDecline = snapshot(survivingShorts, 1000 - survivingShorts);
  assert.ok(Math.abs(withNetDecline.coverage.shortQuantity - survivingShorts) < 1e-9);
});

test("volume breakdown explains net changes and permits repeated turns beyond endpoint open interest", () => {
  const points = [point(0, 0), point(step, 1000), point(2 * step, 1100), point(3 * step, 10), point(4 * step, 0)];
  const bars = [bar(-step), bar(0, 100, 100), { ...bar(step), volume: 500 }, { ...bar(2 * step), volume: 9000 }, { ...bar(3 * step), volume: 9 }];
  const replay = replayLiquidations("ETHUSDT", points, bars, 0, step, 4 * step, null);
  assert.deepEqual(replay.intervals.map(({ volumeBreakdown }) => volumeBreakdown), [
    { doubleOpen: 200, doubleClose: 100, longTurnover: 100, shortTurnover: 100 },
    { doubleOpen: 1977.5, doubleClose: 3067.5, longTurnover: 1977.5, shortTurnover: 1977.5 },
    null,
  ]);
  const beforeZero = estimateLiquidationLevels("ETHUSDT", points.slice(0, 4), bars.slice(0, 4), 100, 3 * step);
  assert.ok(Math.abs(beforeZero.coverage.shortQuantity - 10) < 1e-9);
  const snapshot = estimateLiquidationLevels("ETHUSDT", points, bars, 100, 4 * step);
  assert.deepEqual(snapshot.levels, []);
});

test("levels crossed after formation disappear even if the mark returns", () => {
  const points = [point(step, 0), point(2 * step, 30), point(3 * step, 25)];
  const snapshot = estimateLiquidationLevels("JCTUSDT", points, [bar(0), bar(step), bar(2 * step, 94, 106)], 100, 3 * step);
  assert.ok(snapshot.levels.every(({ price, side }) => side === "long" ? price < 94 : price > 106));
  assert.ok(snapshot.levels.some(({ price }) => Math.abs(price - 90) < 1e-9));
  assert.ok(snapshot.levels.some(({ price }) => Math.abs(price - 110) < 1e-9));
});

test("leverage weights use a single profile per side and split the low-leverage remainder", () => {
  const { weights } = getLeverageWeighting("BTCUSDT");
  const expected = [
    [1, 0.294, 0.188],
    [2, 0.252, 0.329],
    [3, 0.21, 0.235],
    [4, 0.084, 0.188],
    [5, 0.07, 0.03],
    [7, 0.05, 0.018],
    [10, 0.03, 0.01],
    [20, 0.01, 0.002],
  ];
  assert.deepEqual(weights.map(({ leverage }) => leverage), expected.map(([leverage]) => leverage));
  for (const [index, { leverage, long, short }] of weights.entries()) {
    const [, expectedLong, expectedShort] = expected[index];
    assert.ok(Math.abs(long - expectedLong) < 1e-12, `unexpected long weight at ${leverage}x`);
    assert.ok(Math.abs(short - expectedShort) < 1e-12, `unexpected short weight at ${leverage}x`);
  }
});

test("50x weight stays separate on eligible contracts and otherwise merges into 20x", () => {
  const profile = { maxLeverage: 50, maintenanceRate: 0.004, notionalCap: 300_000 };
  const tiers = (maxLeverage, level) => getLeverageWeighting("BTCUSDT", null, level, { ...profile, maxLeverage }).weights;
  const expected20 = { leverage: 20, long: 0.009, short: 0.0015, maintenanceRate: 0.004 };
  const expected50 = { leverage: 50, long: 0.001, short: 0.0005, maintenanceRate: 0.004 };
  assert.deepEqual(tiers(50, 1).slice(-2), [expected20, expected50]);
  assert.deepEqual(tiers(150, 1), tiers(50, 1));

  for (const level of [1, 4, 6]) {
    const supported = tiers(50, level);
    for (const ceiling of [20, 25, 49]) {
      const merged = tiers(ceiling, level);
      assert.deepEqual(merged.slice(0, -1), supported.slice(0, -2));
      assert.equal(merged.at(-1).leverage, 20);
      assert.equal(merged.at(-1).maintenanceRate, profile.maintenanceRate);
      for (const side of ["long", "short"]) {
        assert.equal(merged.at(-1)[side], supported.at(-2)[side] + supported.at(-1)[side]);
        assert.ok(Math.abs(merged.reduce((sum, row) => sum + row[side], 0) - 1) < 1e-9);
      }
    }
  }
});

test("position calibration applies collateral to the effective tier after the 50x fallback", () => {
  const tuned = { id: "position-test", marketCapSlope: 0, volatilitySlope: 0,
    leveraged: [{ leverage: 20, long: 0.06, short: 0.04 }, { leverage: 50, long: 0.03, short: 0.02 }],
    position: { lowLeverageShares: { long: [0.6, 0.2, 0.1, 0.1], short: [0.2, 0.5, 0.2, 0.1] },
      collateralMultipliers: [1.3, 1, 0.7] } };
  const profile = { maxLeverage: 50, maintenanceRate: 0.005, notionalCap: 10_000 };
  const weights = getLeverageWeighting("TESTUSDT", null, 1, profile, tuned).weights;
  const at50 = weights.at(-1);
  assert.equal(at50.leverage, 50);
  assert.ok(Math.abs(at50.effectiveMarginRate - 0.0155) < 1e-12);
  assert.equal(at50.maintenanceRate, profile.maintenanceRate);
  assert.ok(Math.abs(weights[0].long - 0.546) < 1e-12);
  const capped = getLeverageWeighting("TESTUSDT", null, 1, { ...profile, maxLeverage: 25 }, tuned).weights.at(-1);
  assert.equal(capped.leverage, 20);
  assert.ok(Math.abs(capped.long - 0.09) < 1e-12);
  assert.ok(Math.abs(capped.effectiveMarginRate - 0.0365) < 1e-12);
  const points = [point(0, 100), point(step, 200), point(2 * step, 200)];
  const trigger = 100 * (1 - at50.effectiveMarginRate) / (1 - profile.maintenanceRate);
  const replay = replayLiquidations("TESTUSDT", points, [bar(0), bar(step, trigger, 100)], 0, step, 2 * step, null, profile, tuned);
  assert.ok(Math.abs(replay.long - 3 * trigger) < 1e-9);
});

test("1x is weighted on both sides and only produces positive levels for shorts", () => {
  const snapshot = estimateLiquidationLevels("BTCUSDT", [point(step, 0), point(2 * step, 100)],
    [bar(0), bar(step)], 100, 2 * step);
  const { long, short } = snapshot.leverageWeighting.weights.find(({ leverage }) => leverage === 1);
  assert.ok(short > 0 && long > 0);
  const lowCap = getLeverageWeighting("INITUSDT").weights.find(({ leverage }) => leverage === 1);
  assert.ok(lowCap.long > long && lowCap.short > short);
  const oneXShort = snapshot.levels.find((band) => band.side === "short" && Math.abs(band.price - 200) < 1e-9);
  assert.ok(oneXShort);
  assert.ok(Math.abs(oneXShort.estimatedLiquidationUsdt / oneXShort.price - 100 * short) < 1e-9);
  assert.ok(snapshot.levels.every(({ price }) => price > 0));
});

test("new positions use the full leverage allocation at the initial-margin liquidation price", () => {
  const snapshot = estimateLiquidationLevels("ETHUSDT", [point(step, 0), point(2 * step, 100)],
    [bar(0), bar(step)], 100, 2 * step);
  assert.ok(!Object.hasOwn(snapshot, "marginScenarios"));
  for (const [side, target, quantity] of [["short", 105, 0.2], ["long", 95, 1]]) {
    const level = snapshot.levels.find((band) => band.side === side && Math.abs(band.price - target) < 1e-9);
    assert.ok(level, `expected ${side} band at ${target}`);
    assert.ok(Math.abs(level.estimatedLiquidationUsdt - quantity * target) < 1e-9);
  }
});

test("adverse-price adds move surviving long and short levels away without counting their size twice", () => {
  for (const [side, close, oldPrice, expectedPrice, originalQuantity] of [
    ["long", 97.5, 95, 94.525, 1], ["short", 102.5, 105, 105.525, 0.2],
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
  assert.ok(Math.abs(shortQuantity - 109.8) < 1e-9);
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
  const proxy = selectMarketCapHistory(rows(29), "binance-cmc-proxy", end, 0);
  assert.equal(proxy.windowDays, 7);
  assert.equal(proxy.medianUsd, 4);
  const short = selectMarketCapHistory(rows(7).filter((_, i) => i !== 2), "coingecko", end, end - 8 * day);
  assert.equal(short.samples, 6);
  assert.equal(short.windowDays, 7);
  assert.equal(selectMarketCapHistory(rows(360).filter((_, i) => i !== 45), "coingecko", end, 0).windowDays, 30);
});

test("calibrated weights stay normalized and within the exchange ceiling in each risk band", () => {
  for (const maxLeverage of [3, 10, 34, 50, 100, 150]) {
    const profile = { maxLeverage, maintenanceRate: 0.004, notionalCap: 10_000 };
    for (const capitalization of [null, ...[1, 30e6, 200e6, 1e9, 4.5e9, 15e9, 45e9].map((medianUsd) => ({ medianUsd }))]) {
      for (let volatility = 1; volatility <= 6; volatility++) {
        const { weights } = getLeverageWeighting("TESTUSDT", capitalization, volatility, profile, calibration);
        assert.equal(new Set(weights.map(({ leverage }) => leverage)).size, weights.length);
        assert.equal(weights.at(-1).leverage, Math.min(maxLeverage, 100));
        for (const side of ["long", "short"]) {
          assert.ok(weights.every((tier) => Number.isFinite(tier[side]) && tier[side] >= 0));
          assert.ok(Math.abs(weights.reduce((sum, tier) => sum + tier[side], 0) - 1) < 1e-12);
        }
      }
    }
  }
  const weighting = getLeverageWeighting("BASEUSDT", null, 1, null, calibration);
  assert.equal(weighting.marketCapBand.factor, 1);
  assert.equal(weighting.factor, 1);
  assert.ok(getLeverageWeighting("BASEUSDT", null, 6, null, calibration).factor < 1);
});

test("the calibrated profile models a near-price short trigger in both live levels and replay", () => {
  const points = [{ time: 0, quantity: 0 }, { time: step, quantity: 100 }, { time: 2 * step, quantity: 100 }];
  const bars = [bar(0, 100, 100), bar(step, 100, 101.5)];
  const profile = { maxLeverage: 100, maintenanceRate: 0.004, notionalCap: 10_000 };
  const live = estimateLiquidationLevels("TESTUSDT", points.slice(0, 2), bars.slice(0, 1), 100, step, null, profile, calibration);
  assert.equal(live.calibrationId, calibration.id);
  const short = live.levels.filter((row) => row.side === "short" && row.price <= 101.5);
  assert.ok(short.length);
  const replay = replayLiquidations("TESTUSDT", points, bars, 0, step, 2 * step, null, profile, calibration);
  assert.equal(replay.calibrationId, calibration.id);
  assert.ok(Math.abs(replay.short - short.reduce((sum, row) => sum + row.estimatedLiquidationUsdt, 0)) < 1e-12);
  assert.equal(replayLiquidations("TESTUSDT", points, bars, 0, step, 2 * step, null, profile).short, 0);
});

test("higher rolling range event levels reduce high-leverage weights while both sides remain normalized", () => {
  const caps = [
    [29_999_999, 0.07, "极度高风险"], [30_000_000, 0.16, "很高风险"], [200_000_000, 0.32, "高风险"],
    [1_000_000_000, 0.49, "中风险"], [4_500_000_000, 0.71, "低风险"],
    [15_000_000_000, 0.87, "较稳定"], [45_000_000_000, 1, "稳定"],
  ];
  const observations = [[null, 1], [1, 1], [2, 0.88], [3, 0.53], [4, 0.31], [5, 0.15], [6, 0.06]];
  const lowShares = { long: [0.35, 0.30, 0.25, 0.10], short: [0.20, 0.35, 0.25, 0.20] };
  for (const [capIndex, [medianUsd, capFactor, label]] of caps.entries()) {
    const cap = { medianUsd, source: "coingecko", windowDays: 360, samples: 360, through: 0 };
    const baselineWeighting = getLeverageWeighting("ETHUSDT", cap);
    assert.equal(baselineWeighting.marketCapBand.label, label);
    if (capIndex > 0) {
      const justBelow = getLeverageWeighting("ETHUSDT", { ...cap, medianUsd: medianUsd - 1 });
      assert.equal(justBelow.marketCapBand.index, capIndex - 1);
    }
    const baseline = baselineWeighting.weights;
    const baseline20 = baseline.find(({ leverage }) => leverage === 20);
    const baseline7 = baseline.find(({ leverage }) => leverage === 7);
    for (const [level, factor] of observations) {
      const result = getLeverageWeighting("ETHUSDT", cap, level);
      assert.equal(result.marketCapBand.index, capIndex);
      assert.equal(result.marketCapBand.factor, capFactor);
      assert.equal(result.volatilityFactor, factor);
      assert.equal(result.factor, capFactor * factor);
      const at20 = result.weights.find(({ leverage }) => leverage === 20);
      const at7 = result.weights.find(({ leverage }) => leverage === 7);
      const low = result.weights.filter(({ leverage }) => leverage <= 4);
      for (const side of ["long", "short"]) {
        assert.ok(Math.abs(at20[side] - baseline20[side] * factor ** 2) < 1e-9);
        assert.ok(Math.abs(at7[side] - baseline7[side] * Math.sqrt(factor)) < 1e-9);
        const lowTotal = low.reduce((sum, row) => sum + row[side], 0);
        for (const [index, weight] of low.entries()) {
          assert.ok(Math.abs(weight[side] / lowTotal - lowShares[side][index]) < 1e-12);
        }
        assert.ok(Math.abs(result.weights.reduce((sum, row) => sum + row[side], 0) - 1) < 1e-9);
      }
    }
  }
});

const rangeBar = (time, amplitude = 0) => ({ time, open: 100, high: 100 + amplitude, low: 100, close: 100 });
const rangeHistory = (amplitudeAt) => Array.from({ length: day / step }, (_, index) =>
  rangeBar(index * step, amplitudeAt(index)));

test("replay weights only new positions using the 24-hour range counts at their opening", () => {
  const opened = day;
  const start = opened - step;
  const end = opened + step;
  const points = [point(start, 0), point(opened, 100), point(end, 100)];
  const trigger = { time: opened, open: 100, high: 106, low: 100, close: 106 };
  const replay = (numberOfSpikes) => replayLiquidations("ETHUSDT", points,
    [...rangeHistory((index) => index < numberOfSpikes ? 19 : 0), trigger], start, start, end, null);
  const calm = replay(0);
  const volatile = replay(5);
  assert.ok(calm.short > 0);
  assert.equal(replay(4).short, calm.short);
  assert.ok(Math.abs(volatile.short / calm.short - 0.06 ** 2) < 1e-9);
});

test("rolling range levels count strict exceedances and exclude the open candle", () => {
  const points = [point(day - step, 0), point(day, 100)];
  const bars = rangeHistory((index) => index < 4 ? 19 : index === 4 ? 18 : 0);
  const result = estimateLiquidationLevels("ETHUSDT", points, [...bars, rangeBar(day, 19)],
    100, day + step / 2).leverageWeighting;
  assert.deepEqual(result.volatilityCounts, [5, 5, 5, 5, 4]);
  assert.equal(result.volatilityLevel, 5);
  assert.equal(result.volatilityFactor, 0.15);
});

test("rolling range levels downgrade to the highest still qualifying level and flag gaps", () => {
  const points = [point(day - step, 0), point(day, 100), point(day + step, 100)];
  const bars = [...rangeHistory((index) => index < 5 ? 19 : index >= 50 && index < 55 ? 8 : 0), rangeBar(day)];
  const estimate = (asOf, history = bars) => estimateLiquidationLevels("ETHUSDT", points, history, 100, asOf).leverageWeighting;
  assert.equal(estimate(day).volatilityLevel, 6);
  const afterExpiry = estimate(day + step);
  assert.deepEqual(afterExpiry.volatilityCounts, [9, 9, 9, 4, 4]);
  assert.equal(afterExpiry.volatilityLevel, 4);
  assert.equal(afterExpiry.volatilityFactor, 0.31);
  const incomplete = estimate(day + step, bars.filter(({ time }) => time !== 20 * step));
  assert.equal(incomplete.volatilityCounts, null);
  assert.equal(incomplete.volatilityLevel, 1);
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

test("an established contract requires 24 hours of history including both OI endpoints", () => {
  assert.equal(LIQUIDATION_POSITION_HISTORY_MS, day);
  const from = day;
  const to = from + LIQUIDATION_POSITION_HISTORY_MS;
  const points = Array.from({ length: (to - from) / step + 1 }, (_, index) => point(from + index * step, 100));
  const bars = points.slice(0, -1).map(({ time }) => ({ ...bar(time), volume: 0 }));
  const requireHistory = (interest, candles, markThrough) => requireLiquidationHistory(interest, candles, from, to, 0, markThrough);
  assert.deepEqual(requireHistory(points, bars), points);
  assert.throws(() => requireHistory(points.slice(1), bars), LiquidationHistoryIncompleteError);
  assert.throws(() => requireHistory(points.slice(0, -1), bars), LiquidationHistoryIncompleteError);
  assert.throws(() => requireHistory(points, bars.filter(({ time }) => time !== from + step)), LiquidationHistoryIncompleteError);
  assert.throws(() => requireHistory(points, [bar(from), ...bars.slice(1)]), LiquidationHistoryIncompleteError);
  assert.throws(() => requireHistory(points, bars, to + step), LiquidationHistoryIncompleteError);
});

test("only a newly listed contract may start at its first published OI, and subsequent gaps fail", () => {
  const start = day + 2 * step;
  const to = start + 2 * step;
  const points = [point(start, 100), point(start + step, 100), point(to, 120)];
  const bars = points.slice(0, -1).map(({ time }) => ({ ...bar(time), volume: 20 }));
  const requireHistory = (interest, candles) => requireLiquidationHistory(interest, candles, to - LIQUIDATION_POSITION_HISTORY_MS, to, day + 1);
  assert.deepEqual(requireHistory(points, bars), points);
  assert.throws(() => requireHistory([points[0], points[2]], bars), LiquidationHistoryIncompleteError);
  assert.throws(() => requireHistory(points, bars.slice(1)), LiquidationHistoryIncompleteError);
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

test("large liquidation zones merge adjacent high-amount bands and rank each side by their own amounts", () => {
  const band = (side, offset, estimatedLiquidationUsdt) => ({
    side, estimatedLiquidationUsdt,
    lowerPrice: side === "long" ? 100 - (offset + 1) * 0.5 : 100 + offset * 0.5,
    upperPrice: side === "long" ? 100 - offset * 0.5 : 100 + (offset + 1) * 0.5,
  });
  const levels = [band("long", 0, 1000), band("long", 1, 200), band("long", 2, 199),
    band("short", 0, 10), band("short", 1, 10), band("short", 4, 8), band("short", 7, 6), band("short", 10, 4)];
  assert.deepEqual(selectLargeLiquidationZones(levels, 100, 0.5), [
    { side: "long", lowerPrice: 99, upperPrice: 100, estimatedLiquidationUsdt: 1200 },
    { side: "short", lowerPrice: 100, upperPrice: 101, estimatedLiquidationUsdt: 20 },
    { side: "short", lowerPrice: 102, upperPrice: 102.5, estimatedLiquidationUsdt: 8 },
    { side: "short", lowerPrice: 103.5, upperPrice: 104, estimatedLiquidationUsdt: 6 },
  ]);
  assert.equal(levels[0].estimatedLiquidationUsdt, 1000);
  assert.deepEqual(selectLargeLiquidationZones([...levels].reverse(), 100, 0.5),
    selectLargeLiquidationZones(levels, 100, 0.5));
});

test("a smooth high-amount run is a large zone and zero or invalid data produces no zones", () => {
  assert.deepEqual(selectLargeLiquidationZones([], 100, 0.5), []);
  const levels = Array.from({ length: 6 }, (_, i) => ({
    side: "long", lowerPrice: 100 - (i + 1) * 0.5, upperPrice: 100 - i * 0.5, estimatedLiquidationUsdt: 20,
  }));
  assert.deepEqual(selectLargeLiquidationZones(levels, 100, 0.5), [
    { side: "long", lowerPrice: 97, upperPrice: 100, estimatedLiquidationUsdt: 120 },
  ]);
  assert.deepEqual(selectLargeLiquidationZones(levels.map((band) => ({ ...band, estimatedLiquidationUsdt: 0 })), 100, 0.5), []);
  assert.deepEqual(selectLargeLiquidationZones(levels, 100, 0), []);
  assert.deepEqual(selectLargeLiquidationZones(levels, NaN, 0.5), []);
});

test("symbols no longer get built-in high leverage profiles", () => {
  for (const symbol of ["BTCUSDT", "CAKEUSDT", "TESTUSDT"]) {
    assert.deepEqual(getLeverageWeighting(symbol).weights.map(({ leverage }) => leverage), [1, 2, 3, 4, 5, 7, 10, 20]);
  }
});

test("replay counts the first touch of each cohort only in the selected window", () => {
  const points = [point(0, 100), point(step, 200), point(2 * step, 200), point(3 * step, 200)];
  const bars = [bar(0), bar(step, 99, 105.1), bar(2 * step, 99, 105.1)];
  const result = replayLiquidations("ETHUSDT", points, bars, 0, step, 3 * step, null);
  assert.equal(result.long, 0);
  assert.ok(Math.abs(result.short - 21) < 1e-9);
  assert.equal(replayLiquidations("ETHUSDT", points, bars, 0, 2 * step, 3 * step, null).total, 0);
  assert.throws(() => replayLiquidations("ETHUSDT", points, bars.slice(1), 0, step, 3 * step, null), /interval is missing/);
});

test("exchange leverage below 20x merges unsupported weights into its ceiling", () => {
  const profile = { maxLeverage: 125, maintenanceRate: 0.004, notionalCap: 50_000 };
  const baseline = getLeverageWeighting("TESTUSDT", null, null, profile).weights;
  for (const maxLeverage of [1, 6, 7]) {
    const capped = getLeverageWeighting("TESTUSDT", null, null, { ...profile, maxLeverage });
    assert.deepEqual(capped.weights.map(({ leverage }) => leverage),
      [...baseline.filter(({ leverage }) => leverage < maxLeverage).map(({ leverage }) => leverage), maxLeverage]);
    for (const side of ["long", "short"]) {
      const ceilingShare = baseline.filter(({ leverage }) => leverage >= maxLeverage).reduce((sum, weight) => sum + weight[side], 0);
      assert.ok(Math.abs(capped.weights.at(-1)[side] - ceilingShare) < 1e-12);
      assert.ok(Math.abs(capped.weights.reduce((sum, weight) => sum + weight[side], 0) - 1) < 1e-9);
    }
  }
});

test("the 24-hour replay covers every interval and counts the first touch of a warmup position", () => {
  const from = LIQUIDATION_POSITION_HISTORY_MS;
  const to = from + LIQUIDATION_BACKTEST_MS;
  const points = Array.from({ length: to / step + 1 }, (_, index) => point(index * step, index ? 200 : 0));
  const bars = points.slice(0, -1).map(({ time }) => time < from ? bar(time) : bar(time, 99, 106));
  const result = replayLiquidations("TESTUSDT", points, bars, 0, from, to, null);
  assert.equal(result.intervals.length, 288);
  assert.ok(result.short > 0);
  assert.equal(result.intervals[0].short, result.short);
  assert.equal(result.intervals[1].short, 0);
  assert.equal(result.intervals[0].time, from);
  assert.equal(result.intervals.at(-1).time, to - step);
});

test("maintenance deduction is applied when the trigger falls in a higher notional bracket", () => {
  const profile = { maxLeverage: 20, maintenanceRate: 0.01, notionalCap: 1_000, brackets: [
    { floor: 0, cap: 1_000, maxLeverage: 20, rate: 0.01, deduction: 0 },
    { floor: 1_000, cap: 10_000, maxLeverage: 20, rate: 0.02, deduction: 10 },
  ] };
  const points = [point(0, 100), point(step, 200), point(2 * step, 200)];
  const bars = [bar(0), bar(step, 96.4, 101)];
  const firstOnly = replayLiquidations("TESTUSDT", points, bars, 0, step, 2 * step, null, { ...profile, brackets: undefined });
  const allBrackets = replayLiquidations("TESTUSDT", points, bars, 0, step, 2 * step, null, profile);
  assert.equal(firstOnly.long, 0);
  const weight = getLeverageWeighting("TESTUSDT", null, null, profile).weights.find(({ leverage }) => leverage === 20);
  const trigger = 100 * (1 - 1 / 20 - 10 / 2000) / (1 - 0.02);
  assert.ok(Math.abs(allBrackets.long - 100 * weight.long * trigger) < 1e-9);
});

test("contracts capped below 50x have the nearest trigger at 20x", () => {
  const profile = { maxLeverage: 49, maintenanceRate: 0.005, notionalCap: 10_000 };
  const points = [point(0, 100), point(step, 200), point(2 * step, 200)];
  const snapshot = estimateLiquidationLevels("BNBUSDT", [point(step, 100), point(2 * step, 200)],
    [bar(0, 100, 100), bar(step, 100, 100)], 100, 2 * step, null, profile);
  const weight = snapshot.leverageWeighting.weights.find(({ leverage }) => leverage === 20);
  const replay = (low, high) => replayLiquidations("BNBUSDT", points, [bar(0), bar(step, low, high)],
    0, step, 2 * step, null, profile);
  assert.equal(replay(99.15, 100.85).total, 0);
  const longTrigger = 100 * (1 - 1 / 20) / (1 - 0.005);
  const shortTrigger = 100 * (1 + 1 / 20) / (1 + 0.005);
  const result = replay(longTrigger, shortTrigger);
  assert.ok(Math.abs(result.long - 100 * weight.long * longTrigger) < 1e-9);
  assert.ok(Math.abs(result.short - 100 * weight.short * shortTrigger) < 1e-9);
  const nearestLong = Math.max(...snapshot.levels.filter(({ side }) => side === "long").map(({ price }) => price));
  const nearestShort = Math.min(...snapshot.levels.filter(({ side }) => side === "short").map(({ price }) => price));
  assert.ok(Math.abs(nearestLong - longTrigger) < 1e-9);
  assert.ok(Math.abs(nearestShort - shortTrigger) < 1e-9);
});

test("50x uses 2% initial margin and can trigger before the 20x positions", () => {
  const profile = { maxLeverage: 50, maintenanceRate: 0.005, notionalCap: 10_000 };
  const points = [point(0, 100), point(step, 200), point(2 * step, 200)];
  const longPrice = 100 * (1 - 1 / 50) / (1 - profile.maintenanceRate);
  const shortPrice = 100 * (1 + 1 / 50) / (1 + profile.maintenanceRate);
  const bars = [bar(0), bar(step, longPrice, shortPrice)];
  const replay = replayLiquidations("BTCUSDT", points, bars, 0, step, 2 * step, null, profile);
  assert.ok(Math.abs(replay.long - 100 * 0.001 * longPrice) < 1e-9);
  assert.ok(Math.abs(replay.short - 100 * 0.0005 * shortPrice) < 1e-9);
});

