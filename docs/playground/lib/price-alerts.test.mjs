import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertDayStart, clampAlertThreshold, clampTurnoverMultiple, DEFAULT_ALERT_OBSERVATION,
  getTurnoverBaseline, getTurnoverMultiple, parseAlertObservation, parseAlertSeconds,
  recordDirectionalPrice, recordPrice, recordPriceLevel,
  restoreAlertSeconds, restoreAlertThreshold, restoreTurnoverMultiple, settlePriceAlert,
} from "./price-alerts.ts";

const checkedVolume = { turnover: 390_000, baseline: 120_000, multiple: 3.25 };

function confirmFirst(state, trigger, confirmedAt = trigger.move.sample.time) {
  settlePriceAlert(state, trigger.pending, { volume: checkedVolume, confirmedAt });
}

test("alert daily changes use the Beijing calendar day of the trigger", () => {
  const midnight = Date.UTC(2026, 10, 23, 16);
  assert.equal(alertDayStart(midnight - 1), Date.UTC(2026, 10, 22, 16));
  assert.equal(alertDayStart(midnight), midnight);
  assert.equal(alertDayStart(midnight + 12 * 3_600_000), midnight);
});

test("observation levels use the original reference even when the first trigger overshoots", () => {
  const state = { samples: [] };
  const tick = (time, price) => recordPriceLevel(state, { time, price }, { up: 5, down: null }, 30);
  assert.equal(tick(1000, 100), null);
  const first = tick(11000, 108);
  assert.equal(first.needsTurnover, true);
  assert.equal(first.move.level, 1);
  assert.equal(first.move.target, 105);
  confirmFirst(state, first);
  assert.equal(state.series.latest, first.move);
  assert.equal(tick(40000, 110.2499), null);
  const second = tick(95000, 110.25);
  assert.equal(second.needsTurnover, false);
  assert.equal(second.move.level, 2);
  assert.ok(Math.abs(second.move.previous - 105) < 1e-10);
  assert.ok(Math.abs(second.move.target - 110.25) < 1e-10);
  assert.equal(second.move.threshold, 5);
  assert.deepEqual(second.volume, checkedVolume);
  assert.equal(second.move.originalReference, 100);
  assert.equal(tick(150000, 115.7624), null);
  assert.equal(tick(151000, 115.7625).move.level, 3);
});

test("fast moves can skip levels in both directions, including the first alert", () => {
  for (const [threshold, firstPrice, nextPrice] of [[5, 116, 128], [-5, 85, 77]]) {
    const state = { samples: [] };
    const rules = threshold > 0 ? { up: threshold, down: null } : { up: null, down: threshold };
    const tick = (time, price) => recordPriceLevel(state, { time, price }, rules, 30);
    tick(1000, 100);
    const first = tick(2000, firstPrice);
    assert.equal(first.move.level, 3);
    assert.equal(first.needsTurnover, true);
    confirmFirst(state, first);
    const next = tick(3000, nextPrice);
    assert.equal(next.move.level, 5);
    assert.equal(next.needsTurnover, false);
  }
});

test("observation starts at confirmation and uses only subsequent prices for upgrades", () => {
  const state = { samples: [] };
  const tick = (time, price) => recordPriceLevel(state, { time, price }, { up: 5, down: null }, 30);
  tick(1000, 100);
  const first = tick(2000, 108);
  assert.equal(tick(3000, 116), null);
  assert.equal(tick(2500, 125), null);
  assert.equal(tick(4000, 110), null);
  assert.equal(state.series, undefined);
  confirmFirst(state, first, 5000);
  assert.equal(state.series.latest, first.move);
  assert.equal(tick(4500, 122), null);
  const next = tick(6000, 110.25);
  assert.equal(next.needsTurnover, false);
  assert.equal(next.move.level, 2);
});

test("a failed turnover check allows a fresh short-window trigger immediately", () => {
  const state = { samples: [] };
  const rule = { ...DEFAULT_ALERT_OBSERVATION, minutes: 1 };
  const tick = (time, price) => recordPriceLevel(state, { time, price }, { up: 5, down: -5 }, 30, rule);
  tick(1000, 100);
  const first = tick(2000, 105);
  assert.equal(tick(3000, 110.25), null);
  settlePriceAlert(state, first.pending, null);
  confirmFirst(state, first);
  assert.equal(state.series, undefined);
  const next = tick(4000, 116);
  assert.equal(next.needsTurnover, true);
  assert.equal(next.move.level, 1);
  assert.equal(next.move.originalReference, 110.25);
});

test("each upgrade resets the configured deadline and expiry requires a fresh check", () => {
  const state = { samples: [] };
  const rule = { ...DEFAULT_ALERT_OBSERVATION, minutes: 2 };
  const tick = (time, price) => recordPriceLevel(state, { time, price }, { up: 5, down: null }, 30, rule);
  tick(1000, 100);
  const first = tick(2000, 108);
  confirmFirst(state, first, 5000);
  assert.equal(tick(124999, 111).move.level, 2);
  assert.equal(tick(125000, 112), null);
  assert.equal(tick(200000, 115.7625).move.level, 3);
  assert.equal(tick(319998, 101), null);
  assert.equal(tick(319999, 115.7625), null);
  assert.equal(state.series.latest.level, 3);
  assert.equal(tick(320000, 121.56), null);
  assert.equal(state.series, undefined);
  const next = tick(321000, 128);
  assert.equal(next.needsTurnover, true);
  assert.equal(next.move.level, 1);
  assert.equal(next.move.originalReference, 121.56);
  confirmFirst(state, first);
  assert.equal(state.series, undefined);
  confirmFirst(state, next);
  assert.equal(state.series.latest.level, 1);
});

test("compounded observation bands follow the first direction until price returns to the reference", () => {
  const state = { samples: [] };
  const observation = { minutes: 8, upPercent: 4, downPercent: 6 };
  const tick = (time, price) => recordPriceLevel(state, { time, price }, { up: 3, down: -3 }, 30, observation);
  tick(1000, 100);
  const first = tick(2000, 103);
  assert.equal(first.move.level, 1);
  confirmFirst(state, first);
  assert.equal(tick(3000, 103.9), null);
  for (const [time, price, level] of [[4000, 104, 2], [96000, 108.16, 3]]) {
    const upgrade = tick(time, price);
    assert.equal(upgrade.move.level, level);
    assert.equal(upgrade.move.threshold, 4);
    assert.equal(upgrade.move.originalReference, 100);
    assert.equal(upgrade.move.observationMinutes, 8);
    assert.equal(upgrade.needsTurnover, false);
  }
  assert.equal(tick(97000, 101), null);
  assert.equal(tick(98000, 108.16), null);
  assert.equal(tick(99000, 100), null);
  assert.equal(state.series, undefined);
  const next = tick(100000, 97);
  assert.equal(next.needsTurnover, true);
  assert.equal(next.move.threshold, -3);
  confirmFirst(state, next);
  assert.equal(tick(101000, 94.01), null);
  assert.equal(tick(102000, 94).move.level, 2);
  const down = tick(103000, 88.36).move;
  assert.equal(down.level, 3);
  assert.equal(down.threshold, -6);
  assert.equal(down.originalReference, 100);
  assert.equal(tick(104000, 100.01), null);
  assert.equal(state.series, undefined);
});

test("a late turnover response cannot confirm a round that returned to the reference", () => {
  const state = { samples: [] };
  const rule = { ...DEFAULT_ALERT_OBSERVATION, minutes: 1 };
  const tick = (time, price) => recordPriceLevel(state, { time, price }, { up: 5, down: -5 }, 30, rule);
  tick(1000, 100);
  const old = tick(2000, 105);
  assert.equal(tick(3000, 99), null);
  assert.equal(state.series, undefined);
  const next = tick(4000, 94);
  assert.equal(next.move.threshold, -5);
  confirmFirst(state, old);
  settlePriceAlert(state, old.pending, null);
  assert.equal(state.series, undefined);
  confirmFirst(state, next);
  assert.equal(state.series.latest.originalReference, 99);
});

test("observation settings accept integer minutes and independent percentages", () => {
  assert.deepEqual(parseAlertObservation("15", "5", "5"), DEFAULT_ALERT_OBSERVATION);
  assert.deepEqual(parseAlertObservation(22, 3.25, 7), { minutes: 22, upPercent: 3.25, downPercent: 7 });
  for (const input of [[0, 5, 5], [1.5, 5, 5], [15, "", 5], [15, Infinity, 5], [15, 4, -5], [15, 4, 101]]) {
    assert.equal(parseAlertObservation(...input), null);
  }
});

test("turnover input clamps numeric values to 2 through 100 times", () => {
  for (const value of ["0", "-2", "1.99", "2"]) assert.equal(clampTurnoverMultiple(value), 2);
  assert.equal(clampTurnoverMultiple(" 2.25 "), 2.25);
  for (const value of ["100", "100.01", "150"]) assert.equal(clampTurnoverMultiple(value), 100);
  for (const value of ["", " ", "Infinity", "abc"]) assert.equal(clampTurnoverMultiple(value), null);
});

test("saved turnover settings are clamped to the current limits", () => {
  assert.equal(restoreTurnoverMultiple("1.25"), 2);
  assert.equal(restoreTurnoverMultiple("120"), 100);
  assert.equal(restoreTurnoverMultiple("3.5"), 3.5);
  assert.equal(restoreTurnoverMultiple(""), null);
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

test("threshold inputs clamp by direction and support percent formatting", () => {
  assert.equal(clampAlertThreshold("+3.5", "up"), 3.5);
  assert.equal(clampAlertThreshold("-50%", "down"), -50);
  assert.equal(clampAlertThreshold("50%", "down"), -50);
  for (const direction of ["up", "down"]) {
    const sign = direction === "up" ? 1 : -1;
    for (const value of ["0", "1.99%", "2%"]) assert.equal(clampAlertThreshold(value, direction), sign * 2);
    for (const value of ["100%", "100.01", "250"]) assert.equal(clampAlertThreshold(value, direction), sign * 100);
    for (const value of ["", "%", "Infinity", "abc"]) assert.equal(clampAlertThreshold(value, direction), null);
  }
  assert.equal(clampAlertThreshold("-5", "up"), 2);
  assert.equal(clampAlertThreshold("-120%", "down"), -100);
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
  for (const seconds of [10, 180, 300]) assert.equal(parseAlertSeconds(String(seconds)), seconds);
  for (const value of ["", "0", "-1", "9", "10.5", "301", "3600", "Infinity"]) assert.equal(parseAlertSeconds(value), null);
});

test("older settings are brought within the supported bounds", () => {
  assert.equal(restoreAlertThreshold("0.5%"), 2);
  assert.equal(restoreAlertThreshold("-0.5%"), -2);
  assert.equal(restoreAlertThreshold("-2.5%"), -2.5);
  assert.equal(restoreAlertThreshold("-100%"), -100);
  assert.equal(restoreAlertThreshold("150%"), 100);
  assert.equal(restoreAlertSeconds("3600"), 300);
  assert.equal(restoreAlertSeconds("60"), 60);
  assert.equal(restoreAlertSeconds("5"), 10);
  assert.equal(restoreAlertSeconds("1.5"), null);
});

test("a ten-second window can trigger at exactly two percent in either direction", () => {
  for (const [threshold, price] of [[2, 0.0102], [-2, 0.0098]]) {
    const state = { samples: [] };
    recordPrice(state, { time: 1000, price: 0.01 }, threshold, 10);
    assert.equal(recordPrice(state, { time: 11000, price }, threshold, 10).triggered, true);
  }
  const belowThreshold = { samples: [] };
  recordPrice(belowThreshold, { time: 1000, price: 0.01 }, 2, 10);
  assert.equal(recordPrice(belowThreshold, { time: 11000, price: 0.0101999 }, 2, 10).triggered, false);
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
