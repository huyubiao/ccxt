import assert from "node:assert/strict";
import { test } from "node:test";
import { BinanceMarginProfileUnavailableError, createBinanceMarginProfileLoader, readBinanceMarginProfiles } from "./binance-margin-brackets.ts";

const hour = 3_600_000;
const tier = (floor, cap, maxLeverage, rate, deduction) => ({
  bracketNotionalFloor: floor, bracketNotionalCap: cap, maxOpenPosLeverage: maxLeverage,
  bracketMaintenanceMarginRate: rate, cumFastMaintenanceAmount: deduction,
});
const row = (symbol, maxLeverage = 75) => ({
  symbol, riskBrackets: [tier("10000", 50_000, 25, 0.02, 100), tier(0, 10_000, maxLeverage, "0.01", 0)],
});
const table = (...brackets) => ({ success: true, data: { brackets } });

test("validates complete schedules independently of quote currency and rejects a tier gap", () => {
  const incomplete = { symbol: "GAPUSDT", riskBrackets: [tier(0, 5_000, 75, 0.01, 0), tier(7_000, 10_000, 25, 0.02, 40)] };
  const profiles = readBinanceMarginProfiles(table(row("NEWUSDT"), row("NEWUSDC"), incomplete), 123);
  assert.deepEqual([...profiles.keys()], ["NEWUSDT", "NEWUSDC"]);
  assert.deepEqual(profiles.get("NEWUSDC"), {
    maxLeverage: 75, maintenanceRate: 0.01, notionalCap: 10_000, fetchedAt: 123,
    brackets: [
      { floor: 0, cap: 10_000, rate: 0.01, deduction: 0, maxLeverage: 75 },
      { floor: 10_000, cap: 50_000, rate: 0.02, deduction: 100, maxLeverage: 25 },
    ],
  });
});

test("concurrent lookups share the bulk request and a new listing can refresh a fresh snapshot", async () => {
  let now = 0;
  let calls = 0;
  const load = createBinanceMarginProfileLoader(async () => ++calls === 1
    ? table(row("ONEUSDT"), row("TWOUSDC")) : table(row("THREEUSDT")), () => now);
  await Promise.all([load("ONEUSDT"), load("TWOUSDC")]);
  assert.equal(calls, 1);
  await assert.rejects(load("THREEUSDT"), BinanceMarginProfileUnavailableError);
  assert.equal(calls, 1);
  now = 60_000;
  assert.equal((await load("THREEUSDT")).fetchedAt, now);
  assert.equal(calls, 2);
  assert.equal((await load("ONEUSDT")).fetchedAt, 0);
});

test("retains the last valid schedule during partial replies and failures until its original age limit", async () => {
  let now = 0;
  let calls = 0;
  const load = createBinanceMarginProfileLoader(async () => {
    if (++calls === 1) return table(row("BTCUSDT"));
    if (calls === 2) return table(row("OTHERUSDT"));
    throw new Error("Unavailable");
  }, () => now);
  const original = await load("BTCUSDT");
  now = hour;
  assert.equal(await load("BTCUSDT"), original);
  now = hour + 60_000;
  assert.equal(await load("BTCUSDT"), original);
  await assert.rejects(load("CAKEUSDT"), BinanceMarginProfileUnavailableError);
  now = 24 * hour;
  await assert.rejects(load("BTCUSDT"), BinanceMarginProfileUnavailableError);
  assert.equal(calls, 4);
});
