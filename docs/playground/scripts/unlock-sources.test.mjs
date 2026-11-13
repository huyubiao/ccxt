import test from "node:test";
import assert from "node:assert/strict";
import { llamaToken, mergeUnlockEvents, reviewedToken, tokenomistToken } from "./unlock-sources.mjs";
import { fetchUnlockSnapshot } from "./fetch-unlock-snapshot.mjs";

const identity = { geckoId: "initia", base: "INIT" };
const time = Date.parse("2027-04-24T11:37:00Z");

test("uses reviewed Binance supply and DefiLlama unlock without CoinMarketCap", () => {
  const result = reviewedToken(identity);
  assert.equal(result.maxSupply, 1_000_000_000);
  assert.match(result.sourceUrl, /binance\.com/);
  const [event] = mergeUnlockEvents(result.events, time - 1);
  assert.equal(event.sourceName, "DefiLlama");
  assert.equal(event.amount, 7_340_000);
  assert.equal(event.allocations.length, 2);
  assert.deepEqual(mergeUnlockEvents(result.events, time), []);
  assert.equal(reviewedToken({ ...identity, base: "OTHER" }), null);
});

test("prefers corroborated amounts, retains disagreement and separates release types", () => {
  const [event] = reviewedToken(identity).events;
  const defillama = { ...event, amount: 1000 };
  const tokenomist = { ...event, sourceName: "Tokenomist", amount: 500 };
  const cmc = { ...event, sourceName: "CoinMarketCap", amount: 502 };
  const linear = { ...cmc, mechanism: "linear" };
  const [resolved, separate] = mergeUnlockEvents([defillama, tokenomist, cmc, linear], time - 1);
  assert.equal(resolved.amount, 500);
  assert.deepEqual(resolved.sourceChecks.map(({ agrees }) => agrees), [false, true]);
  assert.equal(separate.mechanism, "linear");
});

test("validates provider identity and imports cliff quantities only", () => {
  const llama = { body: { gecko_id: "initia", metadata: { unlockEvents: [
    { timestamp: time / 1000, summary: { totalTokensCliff: 100 },
      cliffAllocations: [{ recipient: "Foundation", amount: 100 }] },
    { timestamp: time / 1000, summary: { totalNewWeeklyRate: 200 }, cliffAllocations: [] },
  ] } } };
  assert.equal(llamaToken(llama, identity).events.length, 1);
  assert.equal(llamaToken(llama, { ...identity, geckoId: "other" }), null);
  const row = { tokenSymbol: "INIT", unlockDate: new Date(time).toISOString(), cliffUnlocks: {
    cliffAmount: 100, allocationBreakdown: [{ allocationName: "Foundation", cliffAmount: 100, unlockPrecision: "day" }],
  } };
  assert.equal(tokenomistToken({ status: true, data: [row] }, identity, "initia").events[0].amount, 100);
  row.cliffUnlocks.allocationBreakdown[0].unlockPrecision = "month";
  assert.deepEqual(tokenomistToken({ status: true, data: [row] }, identity, "initia").events, []);
});

test("imports cliff and linear amounts separately when the provider supplies a complete breakdown", async () => {
  const { token } = await fetchUnlockSnapshot({ geckoId: "sui", base: "SUI" }, {
    now: time - 1,
    request: async (url) => {
      if (!url.includes("/cryptocurrency/detail?")) return {};
      return { status: { error_code: 0 }, data: { id: 20947, slug: "sui", symbol: "SUI", statistics: { maxSupply: 1e10 },
        tokenUnlockLatest: { nextUnlocked: { date: time, tokenAmount: 100 }, nextUnlockedDetail: [
          { allocationName: "Treasury", tokenAmount: 75, vestingType: "linear" },
          { allocationName: "Private Round", tokenAmount: 25, vestingType: "cliff" },
        ] } } };
    },
  });
  assert.deepEqual(token.events.map(({ mechanism, amount }) => [mechanism, amount]), [["cliff", 25], ["linear", 75]]);
  assert.ok(token.events.every(({ allocationComplete }) => allocationComplete));
  assert.equal(token.events[0].allocations[0].group, "insiders");
});

test("loads Lombard unlocks using the CoinGecko ID for BARDUSDT and the CoinMarketCap slug", async () => {
  const unlockTime = Date.parse("2026-11-18T00:00:00Z");
  const { token, refreshed } = await fetchUnlockSnapshot({ geckoId: "lombard-protocol", base: "BARD" }, {
    now: Date.parse("2026-11-13T00:00:00Z"),
    request: async (url) => {
      const { pathname, searchParams } = new URL(url);
      if (!pathname.endsWith("/cryptocurrency/detail")) return {};
      if (searchParams.get("slug") !== "lombard") return { status: { error_code: 400 } };
      return { status: { error_code: 0 }, data: {
        id: 38408, slug: "lombard", symbol: "BARD", statistics: { maxSupply: 1_000_000_000 },
        tokenUnlockLatest: {
          tokenLockedAmount: 614895833.3333333,
          nextUnlocked: { date: unlockTime, tokenAmount: 23854166.66666667 },
          nextUnlockedDetail: [
            { allocationName: "Core Contributors", tokenAmount: 6944444.44444444, vestingType: "linear" },
            { allocationName: "Early Investors", tokenAmount: 5555555.55555556, vestingType: "linear" },
            { allocationName: "Community & Ecosystem", tokenAmount: 6979166.66666667, vestingType: "linear" },
            { allocationName: "Liquid Bitcoin Foundation", tokenAmount: 4375000, vestingType: "linear" },
          ],
        },
      } };
    },
  });
  assert.equal(refreshed, true);
  assert.equal(token.geckoId, "lombard-protocol");
  assert.equal(token.maxSupply, 1_000_000_000);
  assert.equal(token.events[0].time, unlockTime);
  assert.equal(token.events[0].amount, 23854166.66666667);
  assert.equal(token.events[0].mechanism, "linear");
  assert.equal(token.events[0].allocationComplete, true);
  assert.equal(token.events[0].sourceUrl, "https://coinmarketcap.com/currencies/lombard/#token-unlocks");
});

test("reviewed schedule records retain disagreement and do not require a hard cap", () => {
  const [agt] = reviewedToken({ geckoId: "alaya-ai", base: "AGT" }).events;
  assert.equal(agt.mechanism, null);
  assert.equal(agt.sourceChecks[0].agrees, false);
  const arb = reviewedToken({ geckoId: "arbitrum", base: "ARB" });
  assert.equal(arb.maxSupply, undefined);
  assert.equal(mergeUnlockEvents([...arb.events, ...arb.events], arb.events[0].time - 1).length, 1);
});

test("the calendar can supply a verified event if token details are unavailable", async () => {
  const options = {
    now: time - 1,
    request: async () => { throw new Error("detail unavailable"); },
    calendar: { slug: "test-token", symbol: "TEST", nextUnlocked: { date: time, tokenAmount: 100 } },
  };
  const identity = { geckoId: "test-token", base: "TEST" };
  const result = await fetchUnlockSnapshot(identity, options);
  assert.equal(result.refreshed, true);
  assert.equal(result.token.events[0].amount, 100);
  assert.equal(result.token.maxSupply, null);
  const mismatch = await fetchUnlockSnapshot(identity, { ...options, calendar: { ...options.calendar, symbol: "OTHER" } });
  assert.equal(mismatch.refreshed, false);
});
