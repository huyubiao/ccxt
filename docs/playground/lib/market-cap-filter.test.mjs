import { test } from "node:test";
import assert from "node:assert/strict";
import { convertMarketCapBound, parseMarketCapRange, selectMonitoredContracts } from "./market-cap-filter.ts";
import { getContractCoins } from "./market-lookup.ts";

test("market cap bounds can be blank, one-sided, or equal", () => {
  assert.equal(parseMarketCapRange("", "  "), null);
  assert.deepEqual(parseMarketCapRange(" 25000000.5 ", ""), { min: 25000000.5, max: null });
  assert.deepEqual(parseMarketCapRange("", "500000000"), { min: null, max: 500000000 });
  assert.deepEqual(parseMarketCapRange("100", "100"), { min: 100, max: 100 });
});

test("market cap bounds reject invalid values and inverted ranges", () => {
  for (const value of ["-1", "Infinity", "0x10", "abc", "1,000"]) {
    assert.equal(parseMarketCapRange(value, ""), undefined);
    assert.equal(parseMarketCapRange("", value), undefined);
  }
  assert.equal(parseMarketCapRange("201", "200"), undefined);
});

test("ten-thousand-dollar inputs preserve precise inclusive USD bounds", () => {
  const toUsd = (value) => convertMarketCapBound(value, "ten-thousand-usd");
  assert.deepEqual(parseMarketCapRange(toUsd(" 0.0003 "), toUsd("5000.00005")), { min: 3, max: 50_000_000.5 });
  assert.deepEqual(parseMarketCapRange(toUsd(" "), toUsd(".000015")), { min: null, max: 0.15 });
  assert.equal(parseMarketCapRange(toUsd("1e4"), toUsd("")), undefined);
  assert.equal(parseMarketCapRange(toUsd("500.2"), toUsd("500.1")), undefined);
});

test("saved USD bounds display in ten-thousands and round-trip on save", () => {
  for (const [stored, displayed] of [["50000000", "5000"], ["3", "0.0003"], ["0.15", "0.000015"], ["0", "0"], ["", ""]]) {
    assert.equal(convertMarketCapBound(stored, "usd"), displayed);
    assert.equal(convertMarketCapBound(displayed, "ten-thousand-usd"), stored);
  }
});

test("market cap selection includes boundary contracts and excludes missing or out-of-range data", () => {
  const contracts = ["LOW", "MIN", "MID", "MAX", "HIGH", "UNKNOWN", "INVALID", "TRADIFI"]
    .map((id) => ({ id, type: id === "TRADIFI" ? "TRADIFI_PERPETUAL" : "PERPETUAL" }));
  const caps = { LOW: 99, MIN: 100, MID: 150, MAX: 200, HIGH: 201, INVALID: 0, TRADIFI: 150, DELISTED: 150 };
  const select = (min, max) => [...selectMonitoredContracts(contracts, parseMarketCapRange(min, max), caps)];
  assert.deepEqual(select("100", "200"), ["MIN", "MID", "MAX"]);
  assert.deepEqual(select("200", ""), ["MAX", "HIGH"]);
  assert.deepEqual(select("", "100"), ["LOW", "MIN"]);
  assert.deepEqual(select("", ""), contracts.map(({ id }) => id));
  assert.deepEqual([...selectMonitoredContracts(contracts, { min: 100, max: null }, null)], []);
});

test("research, monitoring, and cap coverage count each listed coin once", () => {
  const contracts = [
    { id: "PEPEUSDT", coin: "PEPE", type: "PERPETUAL" },
    { id: "1000PEPEUSDT", coin: "PEPE", type: "PERPETUAL" },
    { id: "BTCUSDT", coin: "BTC", type: "PERPETUAL" },
    { id: "GOLDUSDT", coin: "GOLD", type: "TRADIFI_PERPETUAL" },
  ];
  const caps = { PEPEUSDT: 150, "1000PEPEUSDT": 150, BTCUSDT: 250, REMOVEDUSDT: 150 };
  const all = selectMonitoredContracts(contracts, null, null);
  const covered = selectMonitoredContracts(contracts, { min: null, max: null }, caps);
  const matched = selectMonitoredContracts(contracts, { min: 100, max: 200 }, caps);
  assert.equal(all.size, 4);
  assert.deepEqual(getContractCoins(contracts), new Set(["PEPE", "BTC", "GOLD"]));
  assert.deepEqual(getContractCoins(contracts, all), getContractCoins(contracts));
  assert.deepEqual(getContractCoins(contracts, covered), new Set(["PEPE", "BTC"]));
  assert.deepEqual(getContractCoins(contracts, matched), new Set(["PEPE"]));
  assert.deepEqual(getContractCoins(contracts, new Set(["1000PEPEUSDT", "REMOVEDUSDT"])), new Set(["PEPE"]));

  const refreshed = contracts.filter(({ coin }) => coin !== "PEPE");
  assert.deepEqual(getContractCoins(refreshed), new Set(["BTC", "GOLD"]));
  assert.equal(selectMonitoredContracts(refreshed, { min: 100, max: 200 }, caps).size, 0);
});
