import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const lib = new URL("./", import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(lib.href) && /^\.\/[a-z-]+$/.test(specifier)) {
      return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const { openBackgroundStore } = await import("./background-monitor-store.ts");
const { defaultBackgroundRule, readBackgroundRule } = await import("./background-monitor-types.ts");
const { createBackgroundDetector } = await import("./background-monitor.ts");
const { settlePriceSeries } = await import("./price-alerts.ts");
hooks.deregister();

const event = {
  kind: "market-spike", symbol: "BTCUSDT", time: 1000, seconds: 30, level: 1, previous: 100, price: 106, change: 6, threshold: 5,
};

test("new rules enforce both minimums and legacy rules load within them", () => {
  const store = openBackgroundStore(":memory:");
  try {
    const rule = { ...defaultBackgroundRule, seconds: 10, up: 2, down: -2 };
    assert.deepEqual(readBackgroundRule(rule), rule);
    for (const change of [{ seconds: 9 }, { up: 1.99 }, { down: -1.99 }]) {
      assert.equal(readBackgroundRule({ ...rule, ...change }), null);
    }
    store.saveRule({ ...rule, seconds: 5, up: 1, down: -1.5 });
    assert.deepEqual(store.status(1000).rule, rule);
    assert.deepEqual(store.rule(), rule);
    store.saveRule({ ...rule, up: null });
    assert.equal(store.rule().up, null);
  } finally { store.close(); }
});

test("rules and DingTalk results survive reopening, with exclusive delivery and bounded retries", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ccxt-monitor-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "monitor.sqlite");
  const store = openBackgroundStore(file);
  const another = openBackgroundStore(file);
  const rule = { ...defaultBackgroundRule, enabled: true, notify: true, up: 5 };
  try {
    assert.deepEqual(store.rule(), defaultBackgroundRule);
    assert.deepEqual(readBackgroundRule(rule), rule);
    assert.equal(readBackgroundRule({ ...rule, down: -100 }), null);
    store.saveRule(rule);
    assert.ok(store.heartbeat("first", "connected", 1000));
    assert.ok(!another.heartbeat("second", "idle", 2000));
    assert.equal(another.status(2000).worker, "connected");
    store.record("first-alert", event, 2500, true);
    store.record("first-alert", event, 2500, true);
    assert.equal(store.claim(3000).attempts, 1);
    assert.equal(another.claim(3001), undefined);
    store.finish("first-alert", 1, "rate-limited", 3500);
    assert.equal(another.status(3600).records[0].lastResult, "rate-limited");
    assert.equal(another.claim(63499), undefined);
    assert.equal(another.claim(63500).attempts, 2);
    another.finish("first-alert", 2, "failed", 63501);
    assert.equal(another.claim(183501).attempts, 3);
    another.finish("first-alert", 3, "failed", 183502);
    assert.equal(another.claim(999999), undefined);
    store.release("first");
  } finally {
    another.close();
    store.close();
  }
  const reopened = openBackgroundStore(file);
  try {
    const data = reopened.status(184000);
    assert.deepEqual(data.rule, rule);
    assert.equal(data.worker, "offline");
    assert.equal(data.records.length, 1);
    assert.equal(data.records[0].delivery, "failed");
    assert.equal(data.records[0].attempts, 3);
    assert.ok(reopened.heartbeat("second", "connecting", 184000));
  } finally { reopened.close(); }
});

test("an interrupted send becomes unknown and notifications-off alerts stay in the history", () => {
  const store = openBackgroundStore(":memory:");
  try {
    store.record("interrupted", event, 1000, true);
    store.record("without-push", event, 2000, false);
    assert.equal(store.claim(1000).id, "interrupted");
    assert.equal(store.claim(61000), undefined);
    assert.deepEqual(store.status(61000).records.map(({ delivery }) => delivery), ["disabled", "unknown"]);
  } finally { store.close(); }
});

test("price checks and alert context survive the worker releasing its lease", () => {
  const store = openBackgroundStore(":memory:");
  try {
    assert.equal(store.status(1000).configured, false);
    store.saveRule(defaultBackgroundRule);
    assert.equal(store.status(1000).configured, true);
    assert.ok(store.heartbeat("first", "connected", 1500));
    store.recordSpike({ ...event, status: "pending", requiredMultiple: 3 });
    assert.equal(store.status(1600).spikes[0].status, "pending");
    store.interruptSpikes("other");
    assert.equal(store.status(1700).spikes[0].status, "pending");
    store.interruptSpikes("first");
    store.release("first");
    assert.equal(store.status(1800).spikes[0].status, "interrupted");

    const volume = { turnover: 2500, baseline: 1000, multiple: 2.5 };
    store.recordSpike({ ...event, status: "below-threshold", requiredMultiple: 3, volume });
    assert.equal(store.status(1900).spikes.length, 1);
    assert.deepEqual(store.status(1900).spikes[0].volume, volume);
    assert.ok(store.record("alert", event, 2000, false));
    assert.equal(store.record("alert", event, 2000, false), false);
    store.saveContext("alert", "queue-skipped");
    assert.equal(store.status(2100).records[0].event.context, "queue-skipped");
  } finally { store.close(); }
});

test("the background detector uses event times and confirms later levels of a checked series", () => {
  const queued = [];
  const confirmed = [];
  const observe = createBackgroundDetector({ ...defaultBackgroundRule, up: 5, down: null },
    (event) => confirmed.push(event), (job) => queued.push(job));
  const pair = { id: "BTCUSDT" };
  observe(pair, 1000, 100);
  observe(pair, 121000, 106);
  observe(pair, 120000, 95);
  assert.equal(queued.length, 0, "large gaps and out-of-order frames cannot trigger an alert");
  observe(pair, 122000, 112);
  assert.equal(queued[0].event.level, 1);
  assert.equal(queued[0].event.time, 122000);
  settlePriceSeries(queued[0].state, queued[0].series, true);
  observe(pair, 123000, 118);
  assert.equal(confirmed[0].level, 2);
});
