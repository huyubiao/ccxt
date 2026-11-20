import assert from "node:assert/strict";
import { test } from "node:test";
import { holderMarketCapPercentage, parseBitcoinRichList, rawInteger, tokenAmount, withHolderMarketCap } from "./holder-concentration.ts";
import { geckoHolderPlatforms, supportedHolderPlatforms } from "./holder-platforms.ts";

test("token balances preserve precision when converting base units", () => {
  assert.equal(tokenAmount(50162736194264694000000000000000n, 18), "50162736194264.694");
  assert.equal(tokenAmount(1n, 18), "0.000000000000000001");
  assert.equal(tokenAmount(1000000n, 6), "1");
  assert.equal(tokenAmount(200n, 0), "200");
  assert.throws(() => tokenAmount(-1n, 18));
  assert.throws(() => tokenAmount(1n, -1));
});

test("concentration uses maximum supply and stays unavailable without a verified cap", () => {
  assert.equal(holderMarketCapPercentage("50", 200), 25);
  assert.equal(holderMarketCapPercentage("250", 200), 125);
  assert.equal(holderMarketCapPercentage("0", 200), 0);
  assert.equal(holderMarketCapPercentage("50", null), null);
  assert.equal(holderMarketCapPercentage("50", 0), null);
});

test("cached holder balances are reused with the new denominator", () => {
  const snapshot = {
    status: "available", message: null, symbol: "TEST", chain: "Test", tokenAddress: null,
    fetchedAt: 1, stale: false, sourceName: "Test", sourceUrl: null,
    totalAmount: "70", circulatingSupply: 100, circulatingPercentage: 70,
    rows: [{ address: "test", label: null, amount: "50", explorerUrl: "", circulatingPercentage: 50 }],
  };
  const market = { price: 2, circulatingMarketCap: 200, totalMarketCap: 400 };
  const result = withHolderMarketCap(snapshot, { ...market, supplyLimit: "capped", maxSupply: 200 });
  assert.equal(result.totalMarketCapPercentage, 35);
  assert.equal(result.rows[0].totalMarketCapPercentage, 25);
  assert.equal(result.circulatingMarketCapPercentage, null);
  assert.equal("circulatingSupply" in result, false);
  assert.equal("circulatingPercentage" in result.rows[0], false);

  const unlimited = withHolderMarketCap(snapshot, { ...market, totalMarketCap: null, supplyLimit: "unlimited", maxSupply: null });
  assert.equal(unlimited.supplyLimit, "unlimited");
  assert.equal(unlimited.totalMarketCapPercentage, null);
  assert.equal(unlimited.circulatingMarketCapPercentage, 70);
  assert.equal(unlimited.rows[0].circulatingMarketCapPercentage, 50);

  const unknown = withHolderMarketCap(snapshot, { ...market, totalMarketCap: null, supplyLimit: "unknown", maxSupply: null });
  assert.equal(unknown.totalMarketCapPercentage, null);
  assert.equal(unknown.circulatingMarketCapPercentage, null);
  assert.equal(unknown.rows[0].circulatingMarketCapPercentage, null);

  for (const invalidMarket of [{ price: null }, { price: 0 }, { circulatingMarketCap: null }, { circulatingMarketCap: 0 }]) {
    const missing = withHolderMarketCap(snapshot, { ...market, ...invalidMarket, supplyLimit: "unlimited", maxSupply: null });
    assert.equal(missing.circulatingMarketCapPercentage, null);
    assert.equal(missing.rows[0].circulatingMarketCapPercentage, null);
  }
});

test("a top-200 total is computed from exact base units before conversion", () => {
  const raw = Array.from({ length: 200 }, (_, index) => BigInt(index + 1) * 10n ** 18n);
  const total = tokenAmount(raw.reduce((sum, amount) => sum + amount, 0n), 18);
  assert.equal(total, "20100");
  assert.equal(holderMarketCapPercentage(total, 100000), 20.1);
});

test("native-chain balances preserve integer strings and reject unsafe numeric values", () => {
  assert.equal(rawInteger("9896488105123606"), 9896488105123606n);
  assert.equal(rawInteger(123), 123n);
  assert.throws(() => rawInteger(9896488105123606));
  assert.throws(() => rawInteger(undefined));
});

test("the Bitcoin source must contain all 100 distinct addresses in rank order", () => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const rows = Array.from({ length: 100 }, (_, i) => {
    const address = "1" + "A".repeat(25) + alphabet[Math.floor(i / 58)] + alphabet[i % 58];
    return `<tr><th scope="row">${i + 1}</th><td>${1000 - i}.12</td><td>${address}</td><td></td></tr>`;
  });
  const parsed = parseBitcoinRichList(rows.join(""));
  assert.equal(parsed.length, 100);
  assert.equal(parsed[0].raw, 100012000000n);
  assert.throws(() => parseBitcoinRichList(rows.slice(0, 99).join("")));
  assert.throws(() => parseBitcoinRichList(rows[0] + rows.join("")));
});

test("verified token contracts can fall back across chains while keeping the primary first", () => {
  const address = "0x" + "ab".repeat(20);
  const platforms = geckoHolderPlatforms({ ethereum: address, "arbitrum-one": address, solana: "not-evm",
    "binance-smart-chain": address, "polygon-pos": address, xdai: "" }, "arbitrum-one");
  const duplicate = { contractChainId: 1, contractAddress: "0x" + "AB".repeat(20) };
  assert.deepEqual(supportedHolderPlatforms([...platforms, duplicate]).map((row) => row.contractChainId), [42161, 1, 56, 137]);
  assert.deepEqual(supportedHolderPlatforms([
    { contractChainId: 1, contractAddress: address }, { contractChainId: 42161, contractAddress: address },
  ], "arbitrum").map((row) => row.contractChainId), [42161, 1]);
});
