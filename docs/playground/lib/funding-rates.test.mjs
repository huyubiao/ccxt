import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeFundingRates } from "./funding-rates.ts";

test("funding retains 12 unique settled observations and separates the upcoming estimate", () => {
  const history = Array.from({ length: 14 }, (_, index) => ({ time: index + 1, rate: "0.0001" }));
  history.push({ time: "13", rate: "0" });
  const snapshot = normalizeFundingRates("binance", "BTCUSDT", 13, history, { time: "14", rate: "-0.00005" });
  assert.deepEqual(snapshot.history.map(({ time }) => time), [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  assert.deepEqual(snapshot.previous, { time: 13, rate: 0 });
  assert.deepEqual(snapshot.next, { time: 14, rate: -0.00005 });
});

test("funding does not turn missing rates or expired estimates into upcoming settlements", () => {
  const history = [{ time: 1, rate: "" }];
  const missing = normalizeFundingRates("okx", "BTC-USDT-SWAP", 2, history, { time: 3, rate: "" });
  assert.equal(missing.previous, null);
  assert.equal(missing.next, null);
  assert.equal(normalizeFundingRates("okx", "BTC-USDT-SWAP", 2, history, { time: 2, rate: 0 }).next, null);
});
