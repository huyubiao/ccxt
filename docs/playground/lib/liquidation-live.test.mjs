import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { LIQUIDATION_INTERVAL_MS as step } from "./liquidation-levels.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === "./liquidation-levels" ? specifier + ".ts" : specifier, context);
  },
});
const { estimateLiveWindow, LIVE_RISK_MAX_AGE_MS, parseBinanceLiquidation,
  rememberLiveSnapshot, subscribeBinanceLiquidations } = await import("./liquidation-live.ts");
hooks.deregister();

const time = 1_795_129_200_000;
const message = (overrides = {}) => JSON.stringify({ e: "forceOrder", E: time + 500,
  o: { s: "ETHUSDT", S: "SELL", T: time, X: "FILLED", ap: "2500.25", p: "2499", q: "10", z: "4", ...overrides } });

test("forceOrder uses completed fills, reverses order side, and checks the contract", () => {
  const long = parseBinanceLiquidation(message(), "ETHUSDT");
  assert.equal(long.time, time);
  assert.equal(long.side, "long");
  assert.equal(long.price, 2500.25);
  assert.equal(long.quantity, 4);
  assert.equal(long.notional, 10_001);
  assert.equal(parseBinanceLiquidation(message({ S: "BUY", X: "EXPIRED" }), "ETHUSDT").side, "short");
  assert.equal(parseBinanceLiquidation(message({ z: "0" }), "ETHUSDT"), null);
  assert.equal(parseBinanceLiquidation(message({ X: "PARTIALLY_FILLED" }), "ETHUSDT"), null);
  assert.equal(parseBinanceLiquidation(message({ ap: "0" }), "ETHUSDT"), null);
  assert.equal(parseBinanceLiquidation(message(), "BTCUSDT"), null);
  assert.equal(parseBinanceLiquidation("{", "ETHUSDT"), null);
});

test("a closed candle sums only the exact pre-open thresholds its mark extremes reach", () => {
  const open = Math.floor(time / step) * step;
  const snapshots = new Map();
  const bar = { time: open, low: 99, high: 101 };
  const triggers = { long: [[99, 2], [98.9, 22]], short: [[100.5, 2], [101, 3], [101.1, 22]] };
  rememberLiveSnapshot(snapshots, { asOf: open - 1200, receivedAt: open - 700, triggers });
  rememberLiveSnapshot(snapshots, { asOf: open - 1, receivedAt: open + 1, triggers: { long: [], short: [] } });
  assert.deepEqual(estimateLiveWindow(bar, snapshots.get(open), [{ from: open, to: open + step }]), {
    ...bar, snapshotTime: open - 1200, streamComplete: true, estimated: {
      long: { notional: 198, lowestPrice: 99, highestPrice: 99 },
      short: { notional: 504, lowestPrice: 100.5, highestPrice: 101 },
    },
  });
  assert.equal(snapshots.has(open + step), false);
  const untouched = estimateLiveWindow({ ...bar, low: 99.01, high: 100.49 }, snapshots.get(open), [{ from: open }]);
  assert.deepEqual(untouched.estimated.long, { notional: 0, lowestPrice: null, highestPrice: null });
  assert.equal(untouched.estimated.short.notional, 0);
});

test("stale snapshots are missing data and a reconnected stream does not cover a candle", () => {
  const open = Math.floor(time / step) * step;
  const bar = { time: open, low: 99, high: 101 };
  const snapshots = new Map();
  const triggers = { long: [], short: [] };
  rememberLiveSnapshot(snapshots, { asOf: open - LIVE_RISK_MAX_AGE_MS - 1, receivedAt: open - 1, triggers });
  assert.equal(estimateLiveWindow(bar, snapshots.get(open), [{ from: open }]).estimated, null);
  rememberLiveSnapshot(snapshots, { asOf: open - LIVE_RISK_MAX_AGE_MS, receivedAt: open, triggers });
  const windows = [{ from: open - 10, to: open + step / 2 }, { from: open + step / 2 + 1 }];
  const result = estimateLiveWindow(bar, snapshots.get(open), windows);
  assert.equal(result.streamComplete, false);
  assert.equal(result.estimated.long.notional, 0);
  assert.equal(estimateLiveWindow(bar, snapshots.get(open), [{ from: open + 1 }]).streamComplete, false);
});

test("the stream reconnects for the active symbol and stops when the panel leaves", (t) => {
  const sockets = [];
  const events = [];
  const states = [];
  const original = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    close() {
      this.closed = true;
      this.onclose?.();
    }
  };
  t.after(() => { globalThis.WebSocket = original; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stop = subscribeBinanceLiquidations("ETHUSDT", (event) => events.push(event), (status) => states.push(status));
  t.after(stop);
  assert.equal(sockets[0].url, "wss://fstream.binance.com/market/ws/ethusdt@forceOrder");
  sockets[0].onopen();
  sockets[0].onmessage({ data: message() });
  assert.equal(events.length, 1);
  sockets[0].close();
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2);
  sockets[1].onopen();
  assert.deepEqual(states, ["connecting", "connected", "reconnecting", "connected"]);
  stop();
  assert.ok(sockets[1].closed);
  t.mock.timers.tick(60_000);
  assert.equal(sockets.length, 2);
});
