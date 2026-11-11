import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeDepthGroup } from "./order-book.ts";

test("depth groups include only their own 100 levels and preserve a partial final group", () => {
  const levels = Array.from({ length: 101 }, (_, i) => [i + 1, 2]);
  assert.deepEqual(summarizeDepthGroup(levels, 0), { firstPrice: 1, lastPrice: 100, amount: 10100 });
  assert.deepEqual(summarizeDepthGroup(levels, 100), { firstPrice: 101, lastPrice: 101, amount: 202 });
  assert.equal(summarizeDepthGroup(levels, 200), null);
});
