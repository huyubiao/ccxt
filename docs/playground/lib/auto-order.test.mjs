import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { AUTO_ORDER_SYMBOL_LIMIT, AUTO_ORDER_WATCH_MS, createAutoOrderMonitor, marketSpikeStrategy } from "./auto-order.ts";

const lib = new URL("./", import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(lib.href) && /^\.\/[a-z-]+$/.test(specifier)) {
      return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const { startAutoOrderThread } = await import("./auto-order-thread.ts");
hooks.deregister();

const spike = { strategy: marketSpikeStrategy, symbol: "BTCUSDT", time: 1000 };
const trend = { ...spike, strategy: { id: "trend", name: "趋势策略" } };

test("strategies on the same symbol share a thread and keep independent inactivity windows", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const started = [];
  const rows = new Map();
  const orders = createAutoOrderMonitor((symbol, report) => {
    const stop = t.mock.fn();
    const quote = t.mock.fn(report);
    started.push({ symbol, stop, quote });
    return { quote, stop };
  }, (row) => rows.set(row.strategy.id, row));
  orders.submit(spike);
  orders.submit(trend);
  assert.equal(started.length, 1);
  assert.equal(AUTO_ORDER_WATCH_MS, 60 * 60_000);
  t.mock.timers.tick(AUTO_ORDER_WATCH_MS - 1);
  orders.observe("BTCUSDT", { time: 2000, price: 106 });
  assert.equal(started[0].quote.mock.callCount(), 1);
  assert.equal(rows.get(trend.strategy.id).quote.price, 106);
  assert.equal(rows.get(spike.strategy.id).quote.price, 106);
  orders.submit({ ...spike, time: 2000 });
  orders.submit({ ...spike, time: 999 });
  assert.equal(started.length, 1);
  assert.equal(rows.get(trend.strategy.id).status, "watching");
  t.mock.timers.tick(1);
  assert.equal(rows.get(trend.strategy.id).status, "finished");
  assert.equal(rows.get(spike.strategy.id).status, "watching");
  assert.equal(started[0].stop.mock.callCount(), 0);
  assert.equal(rows.get(spike.strategy.id).time, 2000);
  t.mock.timers.tick(AUTO_ORDER_WATCH_MS - 1);
  assert.equal(rows.get(spike.strategy.id).status, "finished");
  assert.equal(started[0].stop.mock.callCount(), 1);
});

test("a full monitor rejects new symbols and logs the failure without queuing", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const log = t.mock.method(console, "warn", () => {});
  const rows = new Map();
  const start = t.mock.fn(() => ({ quote() {}, stop() {} }));
  const orders = createAutoOrderMonitor(start, (row) => rows.set(row.symbol, row));
  orders.submit(spike);
  assert.equal(AUTO_ORDER_SYMBOL_LIMIT, 20);
  for (let i = 1; i < AUTO_ORDER_SYMBOL_LIMIT; i++) orders.submit({ ...spike, symbol: `COIN${i}USDT` });
  const extra = { ...spike, symbol: "ETHUSDT" };
  orders.submit(extra);
  assert.equal(rows.get(extra.symbol).status, "failed");
  assert.equal(rows.get(extra.symbol).failure, "capacity");
  assert.equal(log.mock.callCount(), 1);
  assert.match(log.mock.calls[0].arguments.join(" "), /20.*ETHUSDT/);

  orders.submit(trend);
  assert.equal(start.mock.callCount(), 20);
  t.mock.timers.tick(AUTO_ORDER_WATCH_MS);
  assert.equal(rows.get(extra.symbol).status, "failed");
  assert.equal(start.mock.callCount(), 20);
  orders.submit({ ...extra, time: 2000 });
  assert.equal(rows.get(extra.symbol).status, "starting");
  orders.stop();
  assert.equal(rows.get("ETHUSDT").status, "stopped");
});

test("stopping one strategy leaves the common worker running until its last task ends", (t) => {
  const rows = new Map();
  const stop = t.mock.fn();
  const orders = createAutoOrderMonitor((symbol, report) => ({ quote: report, stop }), (row) => rows.set(row.strategy.id, row));
  t.after(() => orders.stop());
  orders.submit(spike);
  orders.submit(trend);
  orders.updateStrategy({ symbol: spike.symbol, strategyId: spike.strategy.id, positionOpen: true });
  orders.stopStrategy(spike.strategy.id);
  assert.equal(rows.get(spike.strategy.id).status, "stopped");
  assert.equal(stop.mock.callCount(), 0);
  orders.observe(spike.symbol, { time: 2000, price: 106 });
  assert.equal(rows.get(spike.strategy.id).quote, null);
  assert.equal(rows.get(trend.strategy.id).quote.price, 106);
  orders.stopStrategy(trend.strategy.id);
  assert.equal(stop.mock.callCount(), 1);
});

test("a shared worker failure stops that symbol's tasks and discards stale reports", (t) => {
  const rows = new Map();
  const workers = [];
  const orders = createAutoOrderMonitor((symbol, report, fail) => {
    workers.push({ symbol, report, fail });
    return { quote: report, stop() {} };
  }, (row) => rows.set(`${row.symbol}:${row.strategy.id}`, row));
  t.after(() => orders.stop());
  orders.submit(spike);
  orders.submit(trend);
  orders.submit({ ...spike, symbol: "ETHUSDT" });
  workers[0].fail();
  assert.equal(rows.get("BTCUSDT:market-spike").status, "failed");
  assert.equal(rows.get("BTCUSDT:trend").status, "failed");
  assert.equal(rows.get("ETHUSDT:market-spike").status, "starting");
  orders.submit({ ...spike, time: 2000 });
  assert.equal(workers.length, 3);
  workers[0].report({ time: 3000, price: 100 });
  assert.equal(rows.get("BTCUSDT:market-spike").quote, null);
  orders.observe("BTCUSDT", { time: 4000, price: 110 });
  assert.equal(rows.get("BTCUSDT:market-spike").quote.price, 110);
});

test("a qualified order condition renews the window and an open position prevents idle expiry", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let snapshot;
  const orders = createAutoOrderMonitor(() => ({ quote() {}, stop() {} }), (row) => { snapshot = row; });
  orders.submit(spike);
  const strategy = { symbol: spike.symbol, strategyId: spike.strategy.id };
  t.mock.timers.tick(AUTO_ORDER_WATCH_MS - 1);
  orders.updateStrategy({ ...strategy, orderConditionMet: true });
  t.mock.timers.tick(1);
  assert.equal(snapshot.status, "starting");
  orders.updateStrategy({ ...strategy, positionOpen: true });
  t.mock.timers.tick(AUTO_ORDER_WATCH_MS);
  assert.equal(snapshot.status, "starting");
  orders.updateStrategy({ ...strategy, positionOpen: false });
  assert.equal(snapshot.status, "finished");
});

test("one Node worker keeps each strategy's range independent of ticks before it joined", { timeout: 5000 }, async (t) => {
  const first = Promise.withResolvers();
  const both = Promise.withResolvers();
  const quotes = new Map();
  const orders = createAutoOrderMonitor(startAutoOrderThread, ({ strategy, quote }) => {
    if (!quote) return;
    quotes.set(strategy.id, quote);
    if (quote.time === 2000) first.resolve();
    if ([...quotes.values()].filter(({ time }) => time === 3000).length === 2) both.resolve();
  });
  t.after(() => orders.stop());
  orders.submit(spike);
  orders.observe(spike.symbol, { time: 2000, price: 106 });
  await first.promise;
  orders.observe(spike.symbol, { time: 2500, price: 105 });
  orders.submit(trend);
  orders.observe(spike.symbol, { time: 1000, price: 90 });
  orders.observe(spike.symbol, { time: 3000, price: 103 });
  await both.promise;
  assert.deepEqual(quotes.get(spike.strategy.id), { time: 3000, price: 103, low: 103, high: 106 });
  assert.deepEqual(quotes.get(trend.strategy.id), { time: 3000, price: 103, low: 103, high: 103 });
});

test("order requests keep their strategy identity and only renew the submitting task", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const rows = new Map();
  const requests = new Map();
  const orders = createAutoOrderMonitor(() => ({ quote() {}, stop() {} }), (row) => rows.set(row.strategy.id, row), (request) => {
    const key = JSON.stringify([request.strategyId, request.symbol, request.id]);
    if (requests.has(key)) return false;
    requests.set(key, request);
    return true;
  });
  orders.submit(spike);
  orders.submit(trend);
  const request = { id: "entry-1", symbol: spike.symbol, strategyId: spike.strategy.id, time: 3000, side: "buy", amount: 0.01 };
  assert.equal(orders.requestOrder({ ...request, strategyId: "inactive" }), false);
  assert.equal(orders.requestOrder({ ...request, amount: 0 }), false);
  t.mock.timers.tick(AUTO_ORDER_WATCH_MS - 1);
  assert.equal(orders.requestOrder(request), true);
  assert.equal(orders.requestOrder(request), false);
  assert.deepEqual([...requests.values()], [request]);
  t.mock.timers.tick(1);
  assert.equal(rows.get(trend.strategy.id).status, "finished");
  assert.equal(rows.get(spike.strategy.id).status, "starting");
});
