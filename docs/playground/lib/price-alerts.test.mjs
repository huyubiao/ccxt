import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getTurnoverBaseline, getTurnoverMultiple, parseAlertSeconds, parseAlertThreshold, parseTurnoverMultiple,
  readOkxAlertRatio, recordDirectionalPrice, recordPrice, recordPriceLevel,
  restoreAlertSeconds, restoreAlertThreshold, settlePriceSeries,
} from "./price-alerts.ts";

test("an overshoot uses the threshold price as the base for the next level", () => {
  const state = { samples: [] };
  const tick = (time, price) => recordPriceLevel(state, { time, price }, 5, 30);
  assert.equal(tick(1000, 100), null);
  const first = tick(11000, 108);
  assert.equal(first.needsTurnover, true);
  assert.equal(first.move.level, 1);
  assert.equal(first.move.target, 105);
  assert.equal(settlePriceSeries(state, first.series, true), first.move);
  assert.equal(tick(40000, 110.24), null);
  const second = tick(41000, 110.25);
  assert.equal(second.needsTurnover, false);
  assert.equal(second.move.level, 2);
  assert.equal(second.move.previous, 105);
  assert.equal(tick(70000, 116).move.level, 3);
});

test("fast moves can skip levels in both directions, including the first alert", () => {
  for (const [threshold, firstPrice, nextPrice] of [[5, 116, 128], [-5, 85, 77]]) {
    const state = { samples: [] };
    const tick = (time, price) => recordPriceLevel(state, { time, price }, threshold, 30);
    tick(1000, 100);
    const first = tick(2000, firstPrice);
    assert.equal(first.move.level, 3);
    assert.equal(first.needsTurnover, true);
    settlePriceSeries(state, first.series, true);
    const next = tick(3000, nextPrice);
    assert.equal(next.move.level, 5);
    assert.equal(next.needsTurnover, false);
  }
});

test("higher levels reached while turnover is pending wait for the first check", () => {
  for (const passed of [true, false]) {
    const state = { samples: [] };
    const tick = (time, price) => recordPriceLevel(state, { time, price }, 5, 30);
    tick(1000, 100);
    const first = tick(2000, 108);
    assert.equal(tick(3000, 116), null);
    assert.equal(tick(2500, 125), null);
    assert.equal(tick(4000, 110), null);
    const latest = settlePriceSeries(state, first.series, passed);
    assert.equal(latest?.level, passed ? 3 : undefined);
    if (passed) assert.equal(latest.sample.time, 3000);
    const next = tick(5000, 122);
    assert.equal(next.needsTurnover, !passed);
    assert.equal(next.move.level, passed ? 4 : 2);
  }
});

test("an expired series cannot bypass the next series' turnover check", () => {
  const state = { samples: [] };
  const tick = (time, price) => recordPriceLevel(state, { time, price }, 5, 30);
  tick(1000, 100);
  const first = tick(2000, 108);
  tick(10000, 108);
  const next = tick(32001, 114);
  assert.equal(next.needsTurnover, true);
  assert.equal(next.move.level, 1);
  assert.equal(next.move.previous, 108);
  settlePriceSeries(state, first.series, true);
  assert.equal(tick(33000, 120), null);
  assert.equal(settlePriceSeries(state, next.series, true).level, 2);
});

test("turnover settings require a finite multiple greater than one", () => {
  assert.equal(parseTurnoverMultiple("3"), 3);
  assert.equal(parseTurnoverMultiple(" 1.25 "), 1.25);
  for (const value of ["", "0", "1", "-2", "Infinity", "abc"]) assert.equal(parseTurnoverMultiple(value), null);
});

test("turnover baseline scales the median of 60 complete minutes to the configured window", () => {
  const minutes = [...Array(30).fill(200), ...Array(29).fill(100), 1_000_000,];
  assert.equal(getTurnoverBaseline(minutes, 30), 100);
  assert.equal(getTurnoverBaseline(minutes, 300), 1000);
  assert.equal(getTurnoverBaseline([...minutes.slice(0, -1), undefined], 60), null);
  assert.equal(getTurnoverBaseline(minutes.slice(1), 60), null);
  assert.equal(getTurnoverBaseline(Array(60).fill(0), 60), null);
});

test("turnover multiples distinguish missing data from a measured zero", () => {
  assert.equal(getTurnoverMultiple({ turnover: 300, baseline: 100 }), 3);
  assert.equal(getTurnoverMultiple({ turnover: 0, baseline: 100 }), 0);
  assert.equal(getTurnoverMultiple({ turnover: null, baseline: 100 }), null);
  assert.equal(getTurnoverMultiple({ turnover: 300, baseline: null }), null);
  assert.equal(getTurnoverMultiple({ turnover: 300, baseline: 0 }), null);
});

test("OKX ratios use the newest usable sample at or before the alert", () => {
  assert.deepEqual(readOkxAlertRatio([
    ["900000", "9"], ["300000", "1"], null, ["600000", ""], ["500000", "3"],
  ], 600000), { status: "ok", data: { time: 500000, ratio: 3, long: 0.75, short: 0.25 } });
  assert.deepEqual(readOkxAlertRatio([["600000", "0"]], 600000), {
    status: "ok", data: { time: 600000, ratio: 0, long: 0, short: 1 },
  });
  assert.deepEqual(readOkxAlertRatio([["900000", "3"], ["600000", "-1"]], 600000), { status: "no-sample" });
});

test("signed thresholds support percent input and reject invalid values", () => {
  assert.equal(parseAlertThreshold("-50%"), -50);
  assert.equal(parseAlertThreshold("+3.5"), 3.5);
  assert.equal(parseAlertThreshold("1%"), 1);
  assert.equal(parseAlertThreshold("-1%"), -1);
  for (const value of ["", "0", "0.99", "-0.99", "-100", "Infinity", "abc"]) assert.equal(parseAlertThreshold(value), null);
});

test("the default window uses samples up to exactly 30 seconds old", () => {
  const state = { samples: [] };
  assert.equal(recordPrice(state, { time: 1000, price: 100 }, -50).triggered, false);
  assert.equal(recordPrice(state, { time: 30000, price: 55 }, -50).triggered, false);
  assert.equal(recordPrice(state, { time: 31000, price: 49 }, -50).triggered, true);
  assert.equal(recordPrice(state, { time: 32000, price: 49 }, -50).triggered, false);
  const expired = { samples: [] };
  recordPrice(expired, { time: 1000, price: 100 }, -50);
  assert.equal(recordPrice(expired, { time: 31001, price: 49 }, -50).triggered, false);
});

test("upward thresholds use the earlier low and ignore out-of-order ticks", () => {
  const state = { samples: [] };
  recordPrice(state, { time: 1000, price: 80 }, 25);
  recordPrice(state, { time: 2000, price: 40 }, 25);
  assert.equal(recordPrice(state, { time: 1500, price: 1 }, 25), null);
  const alert = recordPrice(state, { time: 3000, price: 51 }, 25);
  assert.equal(alert.reference.price, 40);
  assert.equal(alert.triggered, true);
});

test("a drop rebases at the trigger price and requires another full drop", () => {
  const state = { samples: [] };
  const tick = (time, price) => recordPrice(state, { time, price }, -50);
  tick(1000, 100);
  assert.equal(tick(2000, 49).triggered, true);
  assert.equal(tick(3000, 90).triggered, false);
  assert.equal(tick(4000, 40).triggered, false);
  const next = tick(5000, 24);
  assert.equal(next.reference.price, 49);
  assert.equal(next.triggered, true);
  assert.equal(tick(6000, 24).triggered, false);
  assert.equal(state.baseline.time, 5000);
});

test("an expired trigger price gives way to the post-alert rolling window", () => {
  const state = { samples: [] };
  const tick = (time, price) => recordPrice(state, { time, price }, -50, 60);
  tick(1000, 100);
  tick(2000, 49);
  tick(4000, 90);
  assert.equal(tick(61999, 40).triggered, false);
  const next = tick(62000, 40);
  assert.equal(next.reference.price, 90);
  assert.equal(next.triggered, true);
});

test("custom windows accept whole seconds within the supported range", () => {
  for (const seconds of [1, 180, 300]) assert.equal(parseAlertSeconds(String(seconds)), seconds);
  for (const value of ["", "0", "-1", "1.5", "301", "3600", "Infinity"]) assert.equal(parseAlertSeconds(value), null);
});

test("older settings are brought within the supported bounds", () => {
  assert.equal(restoreAlertThreshold("0.5%"), 1);
  assert.equal(restoreAlertThreshold("-0.5%"), -1);
  assert.equal(restoreAlertThreshold("-2.5%"), -2.5);
  assert.equal(restoreAlertThreshold("-100%"), null);
  assert.equal(restoreAlertSeconds("3600"), 300);
  assert.equal(restoreAlertSeconds("60"), 60);
  assert.equal(restoreAlertSeconds("1.5"), null);
});

test("a one-second window can trigger a one-percent move on adjacent samples", () => {
  for (const [threshold, price] of [[1, 0.0101], [-1, 0.0099]]) {
    const state = { samples: [] };
    recordPrice(state, { time: 1000, price: 0.01 }, threshold, 1);
    assert.equal(recordPrice(state, { time: 2000, price }, threshold, 1).triggered, true);
  }
  const belowThreshold = { samples: [] };
  recordPrice(belowThreshold, { time: 1000, price: 0.01 }, 1, 1);
  assert.equal(recordPrice(belowThreshold, { time: 2000, price: 0.0100999 }, 1, 1).triggered, false);
});

test("a 180-second rule applies to the initial window and to the trigger baseline", () => {
  const state = { samples: [] };
  const tick = (time, price) => recordPrice(state, { time, price }, -50, 180);
  tick(1000, 100);
  assert.equal(tick(181000, 49).triggered, true);
  tick(240000, 90);
  assert.equal(tick(360999, 40).triggered, false);
  assert.equal(tick(361000, 40).triggered, true);

  const expired = { samples: [] };
  recordPrice(expired, { time: 1000, price: 100 }, -50, 180);
  assert.equal(recordPrice(expired, { time: 181001, price: 49 }, -50, 180).triggered, false);
});

test("reaching the threshold triggers and rebases in both directions", () => {
  for (const [threshold, price] of [[-50, 50], [50, 150]]) {
    const state = { samples: [] };
    recordPrice(state, { time: 1000, price: 100 }, threshold);
    assert.equal(recordPrice(state, { time: 2000, price }, threshold).triggered, true);
    assert.equal(state.baseline.price, price);
    assert.equal(recordPrice(state, { time: 3000, price }, threshold).triggered, false);
    const nextPrice = threshold < 0 ? price / 2 : price * 1.5;
    assert.equal(recordPrice(state, { time: 4000, price: nextPrice }, threshold).triggered, true);
  }
});

test("up and down rules maintain independent trigger baselines", () => {
  const state = { up: { samples: [] }, down: { samples: [] } };
  const rules = { up: 25, down: -20 };
  const tick = (time, price) => recordDirectionalPrice(state, { time, price }, rules, 60);
  assert.deepEqual(tick(1000, 100), []);
  assert.equal(tick(2000, 125)[0].direction, "up");
  const down = tick(3000, 100);
  assert.equal(down[0].direction, "down");
  assert.equal(down[0].threshold, -20);
  assert.equal(state.up.baseline.price, 125);
  assert.equal(state.down.baseline.price, 100);
  assert.equal(tick(4000, 156.25)[0].direction, "up");
  assert.equal(state.down.baseline.price, 100);
});

test("only selected directions contribute samples and alerts", () => {
  const state = { up: { samples: [] }, down: { samples: [] } };
  const rules = { up: null, down: -50 };
  recordDirectionalPrice(state, { time: 1000, price: 100 }, rules, 60);
  assert.deepEqual(recordDirectionalPrice(state, { time: 2000, price: 200 }, rules, 60), []);
  assert.equal(recordDirectionalPrice(state, { time: 3000, price: 100 }, rules, 60)[0].direction, "down");
  assert.deepEqual(state.up.samples, []);
});
