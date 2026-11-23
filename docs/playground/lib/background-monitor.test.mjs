import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
const { marketSpikeStrategy } = await import("./auto-order.ts");
const { defaultBackgroundRule, readBackgroundRule } = await import("./background-monitor-types.ts");
const { createBackgroundDetector } = await import("./background-monitor.ts");
const { mergeAlertHistory, readSpikeRecords, retainSpikeRecords, saveSpikeRecords, SPIKE_RECORD_LIMIT } = await import("./alert-history.ts");
const { settlePriceSeries, spikeKey } = await import("./price-alerts.ts");
hooks.deregister();

const event = {
  kind: "market-spike", symbol: "BTCUSDT", time: 1000, seconds: 30, level: 1, previous: 100, price: 106, change: 6, threshold: 5,
};

test("alert history includes verification outcomes and deduplicates confirmed records", () => {
  const browser = [{ ...event, time: 3000, status: "interrupted", requiredMultiple: 3 },
    { ...event, status: "pending", requiredMultiple: 3 }];
  const volume = { turnover: 20_000, baseline: 10_000, multiple: 2 };
  const server = [{ ...event, status: "below-threshold", volume, requiredMultiple: 3 },
    { ...event, time: 2000, status: "upgraded", requiredMultiple: 3 },
    { ...event, time: 5000, status: "alerted", requiredMultiple: 3 }];
  const checked = { turnover: 30_000, baseline: 10_000, multiple: 3 };
  const confirmed = [{ event: { ...event, time: 4000, multiple: 3 } }, { event: { ...event, time: 5000, volume: checked } }];
  const history = mergeAlertHistory(browser, server, confirmed);
  assert.deepEqual(history.map(({ time, status }) => [time, status]), [
    [5000, "alerted"], [4000, "alerted"], [3000, "interrupted"], [2000, "upgraded"], [1000, "below-threshold"],
  ]);
  assert.deepEqual(history[0].volume, checked);
  assert.equal(history[0].requiredMultiple, 3);
  assert.equal(history[1].legacyMultiple, 3);
  assert.deepEqual(history[4].volume, volume);
});

test("browser history keeps only the newest 100 triggers when recording or reloading", (t) => {
  const storage = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const rows = Array.from({ length: SPIKE_RECORD_LIMIT + 2 }, (_, index) => ({
    ...event, time: event.time + index, status: "below-threshold", requiredMultiple: 3,
  }));
  storage.set("ccxt-market-spike-records", JSON.stringify(rows.toReversed()));
  const expected = rows.slice(2).toReversed();
  assert.deepEqual(readSpikeRecords().map(({ time }) => time), expected.map(({ time }) => time));
  saveSpikeRecords(retainSpikeRecords(rows));
  const visible = readSpikeRecords();
  assert.deepEqual(visible, expected);
  assert.equal(JSON.parse(storage.get("ccxt-market-spike-records")).length, 100);
  const removed = new Set([spikeKey(visible[0]), spikeKey(visible[2])]);
  const remaining = visible.filter((row) => !removed.has(spikeKey(row)));
  saveSpikeRecords(remaining);
  assert.deepEqual(readSpikeRecords(), remaining);
  assert.equal(remaining.length, 98);
});

test("deleting selected background records backfills across both sources and survives in-flight checks", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ccxt-monitor-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "monitor.sqlite");
  const store = openBackgroundStore(file);
  const worker = openBackgroundStore(file);
  try {
    const legacy = { ...event, time: 900, threshold: -5 };
    const pending = { ...event, time: 1200, threshold: 2.125, status: "pending", requiredMultiple: 3 };
    const opposite = { ...pending, threshold: -5, status: "alerted" };
    for (let index = 0; index < SPIKE_RECORD_LIMIT; index++) {
      store.recordSpike({ ...pending, threshold: event.threshold, time: event.time + index });
      store.record(`confirmed-${index}`, { ...event, time: event.time + index }, event.time + index, false);
    }
    store.record("legacy", legacy, legacy.time, false);
    store.recordSpike(pending);
    store.recordSpike(opposite);

    let status = store.status(1300);
    assert.ok(!status.records.some(({ id }) => id === "legacy"));
    assert.equal(mergeAlertHistory([], status.spikes, status.records).at(-1).time, 1002);
    const deleted = [pending, { ...event, time: 1099 }, { ...event, time: 1098 }];
    store.deleteSpikes(deleted);
    store.deleteSpikes(deleted);
    worker.recordSpike({ ...pending, status: "alerted" });
    worker.record("queued-after-deletion", pending, 1300, true);
    assert.equal(worker.claim(1301).id, "queued-after-deletion");

    status = worker.status(1302);
    const remaining = mergeAlertHistory([], status.spikes, status.records);
    const keys = new Set(remaining.map(spikeKey));
    assert.equal(remaining.length, SPIKE_RECORD_LIMIT);
    assert.ok(keys.has(spikeKey(opposite)));
    assert.ok(keys.has(spikeKey(legacy)));
    assert.ok(deleted.every((row) => !keys.has(spikeKey(row))));
    assert.ok(!status.records.some(({ id }) => id === "queued-after-deletion"));
  } finally {
    worker.close();
    store.close();
  }
});

test("only a new confirmed alert queues an auto-order signal, independently of DingTalk", () => {
  const store = openBackgroundStore(":memory:");
  try {
    const signal = { strategy: marketSpikeStrategy, symbol: event.symbol, time: event.time };
    store.recordSpike({ ...event, status: "below-threshold", requiredMultiple: 3 });
    assert.deepEqual(store.pendingAutoOrderSignals(), []);
    assert.ok(store.record("confirmed", event, 2000, false, signal));
    assert.equal(store.record("confirmed", event, 2000, false, signal), false);
    assert.deepEqual(store.pendingAutoOrderSignals(), [{ id: "confirmed", signal }]);
    assert.ok(store.heartbeat("owner", "connected", 2000));
    store.finishAutoOrderSignal("confirmed", "owner");
    assert.deepEqual(store.pendingAutoOrderSignals(), []);

    const watch = { ...signal, status: "watching",
      quote: { price: 106, time: 2100, low: 105, high: 107 } };
    const otherWatch = { ...watch, time: event.time + 1, strategy: { id: "trend", name: "趋势策略" } };
    store.saveAutoOrderWatch("other", watch);
    assert.deepEqual(store.status(2100).autoOrders, []);
    store.saveAutoOrderWatch("owner", watch);
    store.saveAutoOrderWatch("owner", otherWatch);
    assert.deepEqual(store.status(2100).autoOrders, [otherWatch, watch]);
    store.release("owner");
    assert.deepEqual(store.status(2100).autoOrders, [otherWatch, watch].map((row) => ({ ...row, status: "stopped" })));
  } finally { store.close(); }
});

test("legacy symbol-level watches migrate to one historical row per strategy", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ccxt-monitor-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "monitor.sqlite");
  const legacy = new DatabaseSync(file);
  const strategies = [{ id: "trend", name: "趋势策略", time: 1001 }, { ...marketSpikeStrategy, time: 1000 }];
  const quote = { price: 106, time: 1100, low: 105, high: 107 };
  try {
    legacy.exec("CREATE TABLE auto_order_watch (symbol TEXT PRIMARY KEY, watch TEXT NOT NULL, time INTEGER NOT NULL)");
    legacy.prepare("INSERT INTO auto_order_watch VALUES (?, ?, ?)").run(event.symbol,
      JSON.stringify({ symbol: event.symbol, sources: strategies, status: "watching", quote }), 1001);
  } finally { legacy.close(); }
  const expected = strategies.map(({ time, ...strategy }) => ({ symbol: event.symbol, strategy, time, status: "stopped", quote }));
  for (let i = 0; i < 2; i++) {
    const store = openBackgroundStore(file);
    try {
      assert.deepEqual(store.status(2000).autoOrders, expected);
    } finally { store.close(); }
  }
});

test("order requests on the same symbol persist separately for each strategy", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ccxt-monitor-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "monitor.sqlite");
  const store = openBackgroundStore(file);
  const request = { strategyId: marketSpikeStrategy.id, symbol: "BTCUSDT", id: "entry-1", side: "buy", amount: 0.01, time: 2000 };
  const another = { ...request, strategyId: "trend", side: "sell", time: 2100 };
  try {
    store.heartbeat("owner", "connected", 2000);
    assert.equal(store.recordAutoOrderRequest("other", request), false);
    assert.equal(store.recordAutoOrderRequest("owner", request), true);
    assert.equal(store.recordAutoOrderRequest("owner", request), false);
    assert.equal(store.recordAutoOrderRequest("owner", another), true);
  } finally { store.close(); }
  const reopened = openBackgroundStore(file);
  try {
    assert.deepEqual(reopened.status(2200).autoOrderRequests, [another, request]);
  } finally { reopened.close(); }
});

test("disabling the spike strategy stops its watches and invalidates old signals across a quick re-enable", () => {
  const store = openBackgroundStore(":memory:");
  const rule = { ...defaultBackgroundRule, enabled: true };
  const signal = { strategy: marketSpikeStrategy, symbol: event.symbol, time: event.time };
  const watch = { ...signal, status: "watching", quote: null };
  const other = { ...watch, strategy: { id: "trend", name: "趋势策略" }, time: 1001 };
  const request = { id: "entry", strategyId: marketSpikeStrategy.id, symbol: event.symbol, side: "buy", amount: 1, time: 1002 };
  try {
    store.saveRule(rule);
    assert.ok(store.heartbeat("owner", "connected", 1000));
    const version = store.autoOrderStopVersion(marketSpikeStrategy.id);
    store.saveAutoOrderWatch("owner", watch, version);
    store.saveAutoOrderWatch("owner", other);
    assert.ok(store.record("confirmed", event, 1000, false, signal, version));
    assert.ok(store.recordAutoOrderRequest("owner", request, version));
    store.saveRule({ ...rule, enabled: false });
    store.saveRule(rule);
    store.saveAutoOrderWatch("owner", { ...watch, time: 1010 }, version);
    assert.ok(store.record("stale", event, 1010, false, signal, version));
    assert.equal(store.recordAutoOrderRequest("owner", { ...request, id: "stale" }, version), false);
    const status = store.status(1100);
    assert.deepEqual(status.autoOrders, [other, { ...watch, status: "stopped" }]);
    assert.deepEqual(status.autoOrderRequests, [request]);
    assert.deepEqual(store.pendingAutoOrderSignals(), []);
    assert.notEqual(store.autoOrderStopVersion(marketSpikeStrategy.id), version);
  } finally { store.close(); }
});

test("deleted watch rows stay hidden through quote and status updates, while newer signals can appear", () => {
  const store = openBackgroundStore(":memory:");
  const watch = { strategy: marketSpikeStrategy, symbol: event.symbol, time: event.time, status: "watching", quote: null };
  const other = { ...watch, strategy: { id: "trend", name: "趋势策略" } };
  try {
    assert.ok(store.heartbeat("owner", "connected", 1000));
    store.saveAutoOrderWatch("owner", watch);
    store.saveAutoOrderWatch("owner", other);
    store.deleteAutoOrderWatches([watch]);
    store.saveAutoOrderWatch("owner", { ...watch, status: "stopped" });
    assert.deepEqual(store.status(1100).autoOrders, [other]);

    const newer = { ...watch, time: 1100 };
    store.saveAutoOrderWatch("owner", newer);
    store.deleteAutoOrderWatches([watch]);
    assert.deepEqual(store.status(1200).autoOrders, [newer, other]);
  } finally { store.close(); }
});

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
    const claimed = store.claim(3000);
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.event.forecastDirection, "up");
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
    assert.equal(data.records[0].event.forecastDirection, "up");
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

test("price checks, the forecast direction, and alert context survive the worker releasing its lease", () => {
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
    const confirmed = { ...event, volume, forecastDirection: "down" };
    assert.ok(store.record("alert", confirmed, 2000, true));
    assert.equal(store.record("alert", event, 2000, false), false);
    store.saveContext("alert", "queue-skipped");
    assert.deepEqual(store.status(2100).records[0].event, { ...confirmed, context: "queue-skipped" });
    assert.deepEqual(store.claim(2100).event, { ...confirmed, context: "queue-skipped" });
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
  assert.equal(confirmed.length, 0);
  const volume = { turnover: 390_000, baseline: 120_000, multiple: 3.25 };
  settlePriceSeries(queued[0].state, queued[0].series, volume);
  observe(pair, 123000, 118);
  assert.equal(confirmed[0].level, 2);
  assert.equal(confirmed[0].forecastDirection, "up");
  assert.deepEqual(confirmed[0].volume, volume);
});
