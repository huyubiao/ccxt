import assert from "node:assert/strict";
import { test } from "node:test";
import snapshot from "./coin-unlock-snapshot.json" with { type: "json" };
import { getNextUnlock, getTokenomics } from "./coin-unlocks.ts";

test("Bitcoin issuance uses the saved height and target block interval", () => {
  const btc = getTokenomics("BTCUSDT", snapshot.generatedAt);
  assert.equal(btc.kind, "mining");
  assert.equal(btc.maxSupply, 21000000);
  assert.equal(btc.supplyLimit, "capped");
  assert.equal(btc.mining.blockReward, 3.125);
  assert.equal(btc.mining.estimatedDailyIssuance, 450);
  assert.equal(btc.mining.nextHalvingHeight, 1050000);
  assert.equal(btc.mining.nextBlockReward, 1.5625);
  assert.equal(btc.mining.nextEstimatedDailyIssuance, 225);
  assert.equal(btc.mining.estimatedHalvingTime,
    snapshot.blockHeights.BTCUSDT.time + (1050000 - snapshot.blockHeights.BTCUSDT.height) * 600000);
});

test("SUI shows a locked balance and three ordered future releases with consistent supply percentages", () => {
  const sui = getTokenomics("SUIUSDT", snapshot.generatedAt);
  assert.equal(sui.kind, "vesting");
  assert.ok(sui.lockedAmount > 0);
  assert.equal(sui.events.length, 3);
  for (const [i, event] of sui.events.entries()) {
    assert.ok(event.time > (sui.events[i - 1]?.time ?? snapshot.generatedAt));
    assert.equal(event.supplyPercentage, event.amount / sui.percentageSupply * 100);
    if (event.timeKind === "interval-estimate") assert.ok(event.periodStart < event.time);
  }
  assert.equal(getNextUnlock("SUIUSDT", sui.events[0].time).time, sui.events[1].time);
  const interval = sui.events.find((event) => event.timeKind === "interval-estimate");
  assert.ok(interval);
  assert.ok(!getTokenomics("SUIUSDT", interval.periodStart + 1).events.some((event) => event.time === interval.time));
});

test("missing coverage and unlimited issuance have explicit distinct states", () => {
  const unknown = getTokenomics("MISSING_TEST");
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.lockedAmount, null);
  assert.equal(unknown.supplyLimit, "unknown");
  assert.equal(getNextUnlock("MISSING_TEST"), null);
  assert.equal(getTokenomics("ETHUSDT").supplyLimit, "unlimited");
});

test("ETH exposes variable staking issuance without inventing dated unlocks or daily totals", () => {
  const eth = getTokenomics("ETHUSDT");
  assert.equal(eth.kind, "staking");
  assert.equal(eth.staking.mechanism, "proof-of-stake");
  assert.equal(eth.staking.hasFixedHalving, false);
  assert.equal(eth.staking.hasFeeBurn, true);
  assert.equal(eth.staking.dailyIssuance, null);
  assert.equal(eth.staking.dailyBurn, null);
  assert.equal(eth.staking.dailyNetIssuance, null);
  assert.equal(eth.mining, null);
  assert.equal(eth.events.length, 0);
  assert.match(eth.sourceUrl, /ethereum.org/);
});
