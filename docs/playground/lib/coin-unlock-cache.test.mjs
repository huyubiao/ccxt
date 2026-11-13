import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createUnlockSnapshotReader, getTokenomics, unlockSnapshotAt } from "./coin-unlocks.ts";
import { fetchUnlockSnapshot } from "../scripts/fetch-unlock-snapshot.mjs";

const hour = 3_600_000;
const now = unlockSnapshotAt;
const contract = "CACHE_TEST_USDT";

function token(at) {
  const identity = { symbol: "TEST", sourceName: "Test", sourceUrl: "https://example.com" };
  return {
    ...identity, geckoId: "cache-test", updatedAt: at, lockedAmount: 500,
    supplyLimit: "capped", maxSupply: 1_000, percentageSupply: 1_000, percentageBasis: "maxSupply",
    events: [1, 2, 3].map((offset) => ({
      ...identity, time: at + offset * hour, amount: 100, mechanism: "cliff",
      allocationComplete: true, allocations: [{ name: "Foundation", amount: 100, group: "other" }],
    })),
  };
}

async function temporaryFolder(t) {
  const parent = fileURLToPath(new URL("../.cache/unlocks/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(path.join(parent, "test-"));
  t.after(async () => {
    await unlink(path.join(folder, `${contract}.json`)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(folder);
  });
  return folder;
}

test("fresh, complete bundled records skip the unlock provider", async (t) => {
  const read = createUnlockSnapshotReader(await temporaryFolder(t));
  let calls = 0;
  const refresh = async () => { calls++; };
  const { tokenomics } = await read("SUIUSDT", refresh, getTokenomics("SUIUSDT", now).updatedAt);
  assert.equal(tokenomics.events.length, 3);
  assert.equal(calls, 0);
});

test("fetches missing coverage once, then reads complete records from disk after restart", async (t) => {
  const folder = await temporaryFolder(t);
  const read = createUnlockSnapshotReader(folder);
  let calls = 0;
  const refresh = async (_prior, at) => { calls++; return token(at); };
  const [first, second] = await Promise.all([read(contract, refresh, now), read(contract, refresh, now)]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(path.join(folder, `${contract}.json`), "utf8")).row.events.length, 3);
  const restarted = createUnlockSnapshotReader(folder);
  assert.equal((await restarted(contract, refresh, now)).geckoId, "cache-test");
  assert.equal(calls, 1);
  assert.equal((await restarted(contract, refresh, now + 7 * hour)).tokenomics.events.length, 3);
  assert.equal(calls, 2);
});

test("retries an old empty cache entry immediately after the source mappings change", async (t) => {
  const folder = await temporaryFolder(t);
  await writeFile(path.join(folder, `${contract}.json`), JSON.stringify({ version: 1, attemptedAt: now - 1 }));
  let calls = 0;
  const refresh = async () => { calls++; };
  await createUnlockSnapshotReader(folder)(contract, refresh, now);
  assert.equal(calls, 1);
  await createUnlockSnapshotReader(folder)(contract, refresh, now + 1);
  assert.equal(calls, 1);
});

test("persists partial results and retries missing allocations after the cooldown", async (t) => {
  const folder = await temporaryFolder(t);
  const read = createUnlockSnapshotReader(folder);
  const partial = token(now);
  partial.events[0].allocationComplete = false;
  await read(contract, async () => partial, now);

  const restarted = createUnlockSnapshotReader(folder);
  let calls = 0;
  const refresh = async () => { calls++; throw new Error("Upstream offline"); };
  const duringCooldown = await restarted(contract, refresh, now + hour / 2);
  assert.equal(duringCooldown.tokenomics.events[0].allocationComplete, false);
  assert.equal(calls, 0);
  const afterCooldown = await restarted(contract, refresh, now + 6 * hour);
  assert.equal(calls, 1);
  assert.equal(afterCooldown.tokenomics.lockedAmount, 500);
  assert.equal(afterCooldown.tokenomics.events.length, 0);
  await restarted(contract, refresh, now + 7 * hour);
  assert.equal(calls, 1);
});

test("a refresh with incomplete data preserves verified allocations and supply from disk", async () => {
  const prior = token(now);
  prior.events[0].sourceName = "CoinMarketCap";
  const { token: result } = await fetchUnlockSnapshot({ geckoId: "cache-test", base: "TEST" }, {
    now, prior,
    request: async (url) => {
      if (!url.includes("/cryptocurrency/detail?")) return {};
      return { status: { error_code: 0 }, data: {
        id: 1, slug: "cache-test", symbol: "TEST",
        tokenUnlockLatest: {
          nextUnlocked: { date: prior.events[0].time, tokenAmount: prior.events[0].amount },
          nextUnlockedDetail: [{ allocationName: "Foundation", vestingType: "cliff" }],
        },
      } };
    },
  });
  assert.equal(result.lockedAmount, prior.lockedAmount);
  assert.equal(result.maxSupply, prior.maxSupply);
  assert.deepEqual(result.events[0].allocations, prior.events[0].allocations);
  assert.equal(result.events[0].allocationComplete, true);
});

test("refreshes a complete schedule after one day and keeps it when the source fails", async (t) => {
  const read = createUnlockSnapshotReader(await temporaryFolder(t));
  const original = token(now);
  original.events.forEach((event) => { event.time += 10 * 24 * hour; });
  await read(contract, async () => original, now);
  let calls = 0;
  const refresh = async () => { calls++; throw new Error("offline"); };
  await read(contract, refresh, now + 23 * hour);
  assert.equal(calls, 0);
  const stale = await read(contract, refresh, now + 24 * hour);
  assert.equal(calls, 1);
  assert.equal(stale.tokenomics.updatedAt, now);
  assert.equal(stale.tokenomics.events.length, 3);
});

test("an inconsistent locked amount is shown as unverified", () => {
  assert.equal(getTokenomics(contract, now, { ...token(now), lockedAmount: 1001 }).lockedAmount, null);
  assert.equal(getTokenomics(contract, now, { ...token(now), lockedAmount: 1000 }).lockedAmount, 1000);
});
