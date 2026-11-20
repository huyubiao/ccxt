import assert from "node:assert/strict";
import { test } from "node:test";
import { selectVolumeMultiple } from "./volume-multiple.ts";

const day = 86_400_000;
const asOf = 200 * day + 300_000;

test("the latest completed UTC candle uses a separate 180-day baseline", () => {
  const baseline = Array.from({ length: 180 }, (_, index) => [(19 + index) * day, 20]);
  const rows = [[18 * day, 10_000], ...baseline, [199 * day, 25], [200 * day, 999]];
  assert.equal(selectVolumeMultiple(rows.toReversed(), asOf, 0), 1.25);
  assert.equal(selectVolumeMultiple(rows.filter(([time]) => time !== 80 * day), asOf, 0), null);
});

test("a new contract excludes its partial listing day and needs a positive complete baseline", () => {
  const onboardAt = 196 * day + 300_000;
  const rows = [[196 * day, 9_999], [197 * day, 10], [198 * day, 30], [199 * day, 25]];
  assert.equal(selectVolumeMultiple(rows, asOf, onboardAt), 1.25);
  assert.equal(selectVolumeMultiple([...rows.slice(0, -1), [199 * day, 0]], asOf, onboardAt), 0);
  assert.equal(selectVolumeMultiple([[197 * day, 0], [198 * day, 0], [199 * day, 25]], asOf, onboardAt), null);
  assert.equal(selectVolumeMultiple(rows, asOf, 199 * day), null);
});
