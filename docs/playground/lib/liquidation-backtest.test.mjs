import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { LIQUIDATION_INTERVAL_MS as step } from "./liquidation-levels.ts";

const day = 86_400_000;
const to = Date.UTC(2026, 10, 12);
const from = to - day;
const snapshot = (time) => ({ time, asOf: time - step, bands: [
  { side: "long", lowerPrice: 99, upperPrice: 100, openInterestShare: 0.04, riskLevel: "high" },
  { side: "long", lowerPrice: 97, upperPrice: 98, openInterestShare: 0.07, riskLevel: "extreme" },
  { side: "short", lowerPrice: 101, upperPrice: 102, openInterestShare: 0.06, riskLevel: "extreme" },
] });
globalThis.liquidationReplayFixture = async (_instrument, start, end) => ({
  riskSnapshots: Array.from({ length: (end - start) / step }, (_, index) => snapshot(start + index * step)),
});

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./binance-liquidation-levels") {
      return nextResolve("data:text/javascript,export const getBinanceLiquidationReplay = globalThis.liquidationReplayFixture", context);
    }
    return nextResolve(["./binance-margin-brackets", "./liquidation-levels"].includes(specifier) ? specifier + ".ts" : specifier, context);
  },
});
const { compareLiquidationBands, getLiquidationBacktest } = await import("./liquidation-backtest.ts");
hooks.deregister();

for (const partial of [false, true]) {
  test(partial ? "Swolecharts preserves records from a partial 24-hour window" : "Swolecharts fetches a 24-hour test window in one request", async (t) => {
    const requests = [];
    t.mock.method(Date, "now", () => to + step);
    t.mock.method(globalThis, "fetch", async (url) => {
      if (url.hostname !== "swolecharts.com") return new Response(null, { status: 404 });
      const start = Number(url.searchParams.get("start"));
      const end = Number(url.searchParams.get("end"));
      requests.push({ start, end, step: url.searchParams.get("step") });
      return Response.json({ market: url.searchParams.get("market"), start, end, step,
        t: [start - step, start, end - step, end], long: [100_000, 10_000, 20_000, 100_000], short: [0, 9_999, 0, 0],
        gaps: partial ? [[start + step, end - step]] : [] });
    });
    const result = await getLiquidationBacktest({ id: partial ? "PARTIALUSDT" : "FULLUSDT", onboardAt: from - 14 * day });
    assert.equal(result.from, from);
    assert.equal(result.to, to);
    assert.equal(result.snapshotCount, 288);
    const reference = result.references.find(({ source }) => source === "Swolecharts");
    assert.equal(reference.status, partial ? "partial" : "covered");
    const [long, short] = reference.comparison;
    assert.equal(long.events, 2);
    assert.equal(long.unknown, 2);
    assert.equal(long.hits, 0);
    assert.equal(long.hitRate, null);
    assert.equal(short.events, 0, "the amount threshold is per direction");
    assert.deepEqual(requests, [{ start: from, end: to, step: "5m" }]);
    assert.deepEqual(long.timeline.map(({ time }) => time), [from, to - step]);
  });
}

test("CoinBoss fills are matched individually without averaging their prices", async (t) => {
  t.mock.method(Date, "now", () => to + step);
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.hostname !== "api.coinboss.com") return new Response(null, { status: 404 });
    const fill = (id, price, value_usd) => ({ id, price, value_usd, timestamp: from + id,
      exchange: "binance", symbol: "PRICEDUSDT", side: "LONG" });
    return Response.json({ success: true, data: [fill(2, "100", 5000), fill(1, "99", 5000), fill(1, "99", 5000)] });
  });
  const result = await getLiquidationBacktest({ id: "PRICEDUSDT", onboardAt: from - 14 * day });
  const [long] = result.references.find(({ source }) => source === "CoinBoss").comparison;
  assert.equal(long.events, 1);
  assert.equal(long.misses, 1);
  assert.equal(long.timeline[0].inside, 5000);
  assert.deepEqual(long.timeline[0].prices, { low: 99, high: 100 });
});

test("slow backtests share one request and retain a completed result for thirty seconds", async (t) => {
  let now = to + step;
  let calls = 0;
  let finish;
  const ready = new Promise((resolve) => { finish = resolve; });
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (url) => {
    calls++;
    if (url.hostname !== "swolecharts.com") return new Response(null, { status: 404 });
    await ready;
    const start = Number(url.searchParams.get("start"));
    const end = Number(url.searchParams.get("end"));
    return Response.json({ market: url.searchParams.get("market"), start, end, step,
      t: [start], long: [10], short: [1], gaps: [] });
  });
  const instrument = { id: "SLOWUSDT", onboardAt: from - day };
  const first = getLiquidationBacktest(instrument);
  now += 45_000;
  assert.strictEqual(getLiquidationBacktest(instrument), first);
  finish();
  await first;
  const completedCalls = calls;
  now += 20_000;
  assert.strictEqual(getLiquidationBacktest(instrument), first);
  assert.equal(calls, completedCalls);
  now += step;
  const nextWindow = getLiquidationBacktest(instrument);
  assert.notStrictEqual(nextWindow, first);
  assert.equal((await nextWindow).to, to + step);
});


test("a single predicted band must contain the full notional threshold", () => {
  const times = Array.from({ length: 5 }, (_, index) => from + index * step);
  const [hit, spread, missingPrice, missingSnapshot, partialHit] = times;
  const snapshots = new Map(times.filter((time) => time !== missingSnapshot).map((time) => [time, snapshot(time)]));
  const intervals = {
    [hit]: { long: 10_000, short: 0, fills: { long: [{ price: 99, amount: 6000 }, { price: 99.99, amount: 4000 }] } },
    [spread]: { long: 12_000, short: 10_000, fills: {
      long: [{ price: 99.5, amount: 6000 }, { price: 97.5, amount: 6000 }],
      short: [{ price: 101, amount: 10_000 }],
    } },
    [missingPrice]: { long: 10_000, short: 9999, fills: { long: [{ price: 99, amount: 5000 }] }, missingPrices: { long: true } },
    [missingSnapshot]: { long: 10_000, short: 0, fills: { long: [{ price: 99, amount: 10_000 }] } },
    [partialHit]: { long: 14_000, short: 0, fills: { long: [{ price: 99, amount: 10_000 }] }, missingPrices: { long: true } },
  };
  const [long, short] = compareLiquidationBands({ status: "partial", intervals }, snapshots);
  assert.deepEqual(long.timeline.map(({ result }) => result), ["hit", "miss", "unknown", "unknown", "hit"]);
  assert.equal(long.timeline[1].inside, 12_000);
  assert.equal(long.timeline[2].inside, 5000);
  assert.equal(long.timeline[3].asOf, null);
  assert.equal(long.events, 5);
  assert.equal(long.hits, 2);
  assert.equal(long.misses, 1);
  assert.equal(long.unknown, 2);
  assert.equal(long.hitRate, 2 / 3);
  assert.equal(short.events, 1);
  assert.equal(short.hitRate, 1);
});

test("a known snapshot without high-risk bands gives a miss when prices are available", () => {
  const intervals = { [from]: { long: 10_000, short: 0, fills: { long: [{ price: 99, amount: 10_000 }] } } };
  const [long] = compareLiquidationBands({ status: "covered", intervals },
    new Map([[from, { time: from, asOf: from - step, bands: [] }]]));
  assert.equal(long.misses, 1);
  assert.equal(long.timeline[0].inside, 0);
});
