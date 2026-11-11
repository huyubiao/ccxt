import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { withHolderMarketCap } from "./holder-concentration.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === "./holder-concentration" ? `${specifier}.ts` : specifier, context);
  },
});
const { getBscTokenHolders } = await import("./bsc-holder-source.ts");
hooks.deregister();

const address = "0x5dBde81fcE337FF4bcaaEe4Ca3466C00aeCaE274";
const agt = { address: address.toLowerCase(), symbol: "AGT", decimals: "18" };
const balance = 5n * 10n ** 23n;
const rows = (count) => Array.from({ length: count }, (_, i) => ({
  address: `0x${(i + 1).toString(16).padStart(40, "0")}`, rawBalance: String(BigInt(i + 1) * balance),
}));

test("AGT shows a top-100 concentration with the public BSC source", async () => {
  const snapshot = await getBscTokenHolders(address, "AGT", async (url) => {
    const request = new URL(url);
    assert.equal(request.host, "api.binplorer.com");
    assert.equal(request.searchParams.get("apiKey"), "freekey");
    assert.ok(request.pathname.endsWith(agt.address));
    if (request.pathname.startsWith("/getTokenInfo/")) return agt;
    assert.equal(request.searchParams.get("limit"), "100");
    return { holders: rows(100) };
  });
  assert.equal(snapshot.status, "partial");
  assert.match(snapshot.message, /前 100 个地址/);
  assert.equal(snapshot.chain, "BNB Smart Chain");
  assert.equal(snapshot.tokenAddress, address);
  assert.equal(snapshot.rows.length, 100);
  assert.equal(snapshot.rows[0].amount, "50000000");
  assert.equal(snapshot.totalAmount, "2525000000");
  assert.equal(withHolderMarketCap(snapshot, 5_000_000_000, null).totalMarketCapPercentage, 50.5);
});

test("a personal key requests all 200 holders and duplicate addresses are rejected", async () => {
  const holders = rows(200);
  const request = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("apiKey"), "test-key");
    if (parsed.pathname.startsWith("/getTokenInfo/")) return agt;
    assert.equal(parsed.searchParams.get("limit"), "200");
    return { holders };
  };
  const snapshot = await getBscTokenHolders(address, "AGT", request, "test-key");
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.rows.length, 200);
  holders[1] = holders[0];
  await assert.rejects(getBscTokenHolders(address, "AGT", request, "test-key"), /duplicate BSC holder/);
  await assert.rejects(getBscTokenHolders(address, "OTHER", request, "test-key"), /token metadata/);
});
