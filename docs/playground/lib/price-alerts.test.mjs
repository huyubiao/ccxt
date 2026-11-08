import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAlertSeconds, parseAlertThreshold, recordDirectionalPrice, recordPrice } from "./price-alerts.ts";

test("signed thresholds support percent input and reject invalid values", () => {
  assert.equal(parseAlertThreshold("-50%"), -50);
  assert.equal(parseAlertThreshold("+3.5"), 3.5);
  for (const value of ["", "0", "-100", "Infinity", "abc"]) assert.equal(parseAlertThreshold(value), null);
});

test("a drop exceeding 50% uses samples up to exactly one minute old", () => {
  const state = { samples: [] };
  assert.equal(recordPrice(state, { time: 1000, price: 100 }, -50).triggered, false);
  assert.equal(recordPrice(state, { time: 60000, price: 55 }, -50).triggered, false);
  assert.equal(recordPrice(state, { time: 61000, price: 49 }, -50).triggered, true);
  assert.equal(recordPrice(state, { time: 62000, price: 49 }, -50).triggered, false);
  const expired = { samples: [] };
  recordPrice(expired, { time: 1000, price: 100 }, -50);
  assert.equal(recordPrice(expired, { time: 61001, price: 49 }, -50).triggered, false);
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
  const tick = (time, price) => recordPrice(state, { time, price }, -50);
  tick(1000, 100);
  tick(2000, 49);
  tick(4000, 90);
  assert.equal(tick(61999, 40).triggered, false);
  const next = tick(62000, 40);
  assert.equal(next.reference.price, 90);
  assert.equal(next.triggered, true);
});

test("custom windows accept whole seconds within the supported range", () => {
  for (const seconds of [1, 180, 3600]) assert.equal(parseAlertSeconds(String(seconds)), seconds);
  for (const value of ["", "0", "-1", "1.5", "3601", "Infinity"]) assert.equal(parseAlertSeconds(value), null);
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
