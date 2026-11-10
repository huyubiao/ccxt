import assert from "node:assert/strict";
import { test } from "node:test";
import { holderMarketCapPercentage, parseBitcoinRichList, rawInteger, tokenAmount, withHolderMarketCap } from "./holder-concentration.ts";

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
  const result = withHolderMarketCap(snapshot, 200, 400);
  assert.equal(result.totalMarketCapPercentage, 35);
  assert.equal(result.rows[0].totalMarketCapPercentage, 25);
  assert.equal("circulatingSupply" in result, false);
  assert.equal("circulatingPercentage" in result.rows[0], false);
  assert.equal(withHolderMarketCap(snapshot, null, null).totalMarketCapPercentage, null);
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
