import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAlertTurnover, formatMarketAmount, formatMarketPriceRange, marketNumberFormatter } from "./market-number.ts";

test("alert turnover displays the baseline and window amount in 万 at any scale", () => {
  assert.equal(formatAlertTurnover({ baseline: 2500, turnover: 7500, multiple: 3 }), "成交额3倍(0.25万 -> 0.75万)");
  assert.equal(formatAlertTurnover({ baseline: 100_000_000, turnover: 300_000_000, multiple: 3 }), "成交额3倍(10000万 -> 30000万)");
  assert.equal(formatAlertTurnover({ baseline: 2500, turnover: 0, multiple: 0 }), "成交额0倍(0.25万 -> 0万)");
  assert.equal(formatAlertTurnover({ baseline: null, turnover: null, multiple: null }), null);
  assert.equal(formatAlertTurnover(undefined, 3), "成交额3倍");
});

test("large market values use 万 and 亿 with exactly three decimal places", () => {
  assert.equal(formatMarketAmount(9_999.46), "9,999.46");
  assert.equal(formatMarketAmount(10_000), "1.000万");
  assert.equal(formatMarketAmount(12_940.46), "1.294万");
  assert.equal(formatMarketAmount(129_404.6), "12.940万");
  assert.equal(formatMarketAmount(99_999_000), "9999.900万");
  assert.equal(formatMarketAmount(100_000_000), "1.000亿");
  assert.equal(formatMarketAmount(1_300_495_286_446.27), "13004.953亿");
  assert.equal(formatMarketAmount(null), "—");
  assert.equal(formatMarketAmount(Infinity), "—");
});

test("market prices keep small-price precision and signed amounts keep their signs", () => {
  const price = marketNumberFormatter({ maximumSignificantDigits: 8 });
  const signed = marketNumberFormatter({ maximumFractionDigits: 2, signDisplay: "exceptZero" });
  assert.equal(price(0.0000012345678), "0.0000012345678");
  assert.equal(price(12_940.46), "1.294万");
  assert.equal(signed(129_404.6), "+12.940万");
  assert.equal(signed(-129_404.6), "-12.940万");
  assert.equal(signed(-0), "0");
});

test("price ranges keep distinct endpoints when their compact labels would match", () => {
  const price = marketNumberFormatter({ maximumSignificantDigits: 8 });
  assert.equal(formatMarketPriceRange(9_998, 10_020, price), "9,998 – 1.002万");
  assert.equal(formatMarketPriceRange(129_300, 129_800, price), "12.930万 – 12.980万");
  assert.equal(formatMarketPriceRange(129_400, 129_410, price), "12.940万 – 12.941万");
  assert.equal(formatMarketPriceRange(129_410, 129_400, price), "12.941万 – 12.940万");
  assert.equal(formatMarketPriceRange(129_400, 129_400, price), "12.940万 – 12.940万");
  assert.equal(formatMarketPriceRange(129_400, 129_401, price), "129,400 – 129,401");
});
