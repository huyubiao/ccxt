import assert from "node:assert/strict";
import { test } from "node:test";
import { circulatingPercentage, parseBitcoinRichList, rawInteger, tokenAmount } from "./holder-concentration.ts";

test("token balances preserve precision when converting base units", () => {
  assert.equal(tokenAmount(50162736194264694000000000000000n, 18), "50162736194264.694");
  assert.equal(tokenAmount(1n, 18), "0.000000000000000001");
  assert.equal(tokenAmount(1000000n, 6), "1");
  assert.equal(tokenAmount(200n, 0), "200");
  assert.throws(() => tokenAmount(-1n, 18));
  assert.throws(() => tokenAmount(1n, -1));
});

test("concentration uses circulating supply and preserves ratios above 100 percent", () => {
  assert.equal(circulatingPercentage("50", 200), 25);
  assert.equal(circulatingPercentage("250", 200), 125);
  assert.equal(circulatingPercentage("0", 200), 0);
  assert.equal(circulatingPercentage("50", null), null);
  assert.equal(circulatingPercentage("50", 0), null);
});

test("a top-200 total is computed from exact base units before conversion", () => {
  const raw = Array.from({ length: 200 }, (_, index) => BigInt(index + 1) * 10n ** 18n);
  const total = tokenAmount(raw.reduce((sum, amount) => sum + amount, 0n), 18);
  assert.equal(total, "20100");
  assert.equal(circulatingPercentage(total, 100000), 20.1);
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
