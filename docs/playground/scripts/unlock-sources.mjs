import reviewed from "./reviewed-unlocks.json" with { type: "json" };
const day = 86_400_000;

export function tokenSymbol(identity) {
  return identity.base.toUpperCase().replace(/^(1000000|100000|10000|1000)(?=[A-Z])/, "");
}

export function allocationGroup(name) {
  if (/\b(foundation|treasury|dao|ecosystem|liquidity|staking|reserve|market maker)\b/i.test(name)) return "other";
  if (/\b(team|founders?|advisors?|advisers?|investors?|contributors?|employees?|(?:private|seed) (?:sale|round))\b/i.test(name)) return "insiders";
  if (/\b(public sale|community sale|user|users|airdrop|individual wallets)\b/i.test(name)) return "users";
  return "other";
}

function allocation(name, amount) {
  return typeof name === "string" && name.trim() && Number.isFinite(amount) && amount > 0
    ? { name, amount, group: allocationGroup(name) } : null;
}

function cliff(source, symbol, time, amount, allocations) {
  if (!Number.isFinite(time) || time > 8.64e15 || !Number.isFinite(amount) || amount <= 0) return null;
  const valid = allocations.filter(Boolean);
  const subtotal = valid.reduce((sum, item) => sum + item.amount, 0);
  const tolerance = amount * 1e-7;
  return {
    ...source, symbol, time, amount, timeKind: "scheduled", mechanism: "cliff",
    allocations: subtotal <= amount + tolerance ? valid : [],
    allocationComplete: valid.length > 0 && Math.abs(subtotal - amount) <= tolerance,
  };
}

export function llamaToken(result, identity) {
  const body = result?.body;
  if (body?.gecko_id !== identity.geckoId || !Array.isArray(body.metadata?.unlockEvents)) return null;
  const source = { sourceName: "DefiLlama", sourceUrl: `https://defillama.com/unlocks/${encodeURIComponent(identity.geckoId)}` };
  return {
    ...source,
    events: body.metadata.unlockEvents.flatMap((event) => {
      if (!Array.isArray(event.cliffAllocations)) return [];
      return cliff(source, tokenSymbol(identity), event.timestamp * 1000, event.summary?.totalTokensCliff,
        event.cliffAllocations.map((item) => allocation(item.recipient, item.amount))) ?? [];
    }),
  };
}

export function tokenomistToken(result, identity, slug) {
  if (result?.status !== true || !Array.isArray(result.data) ||
      result.data.some((item) => item.tokenSymbol?.toUpperCase() !== tokenSymbol(identity))) return null;
  const source = { sourceName: "Tokenomist", sourceUrl: `https://tokenomist.ai/${encodeURIComponent(slug)}` };
  return {
    ...source,
    events: result.data.flatMap((item) => {
      const details = item.cliffUnlocks?.allocationBreakdown ?? [];
      // The API may use placeholder dates for events disclosed only to month or week precision.
      if (!Array.isArray(details) || !details.length ||
          details.some((row) => !["second", "minute", "hour", "day"].includes(row.unlockPrecision))) return [];
      return cliff(source, tokenSymbol(identity), Date.parse(item.unlockDate), item.cliffUnlocks.cliffAmount,
        details.map((row) => allocation(row.allocationName, row.cliffAmount))) ?? [];
    }),
  };
}

export function reviewedToken(identity) {
  const record = reviewed[identity.geckoId];
  if (record?.symbol !== tokenSymbol(identity)) return null;
  return {
    ...record,
    events: record.events.flatMap(({ date, note, mechanism = "cliff", sourceChecks, ...source }) => {
      const event = cliff({ sourceName: source.sourceName, sourceUrl: source.sourceUrl, note }, record.symbol,
        Date.parse(date), source.amount, source.allocations.map(({ name, amount }) => allocation(name, amount)));
      return event ? { ...event, mechanism, sourceChecks } : [];
    }),
  };
}

function compareAmounts(a, b) {
  return Math.abs(a - b) <= Math.max(a, b) * 0.01;
}

export function releaseGroup(event) {
  return `${Math.floor(event.time / day)}:${event.mechanism ?? "unknown"}`;
}

export function mergeUnlockEvents(events, now) {
  return mergeReleases(events.filter((event) => event.time > now &&
    (event.timeKind !== "interval-estimate" || event.periodStart >= now)), false);
}

export function isCompletedUnlock(event, now) {
  return Number.isFinite(event.time) && event.time > 0 && event.time <= now &&
    Number.isFinite(event.amount) && event.amount > 0 &&
    (event.timeKind !== "interval-estimate" ||
      (Number.isFinite(event.periodStart) && event.periodStart < event.time));
}

export function recentUnlocks(events, now) {
  return mergeReleases(events.filter((event) => isCompletedUnlock(event, now)), true)
    .sort((a, b) => b.time - a.time).slice(0, 2);
}

function mergeReleases(events, historical) {
  const groups = new Map();
  const estimates = [];
  for (const event of events) {
    if (!Number.isFinite(event.time) || !Number.isFinite(event.amount) || event.amount <= 0) continue;
    if (event.timeKind === "interval-estimate") {
      estimates.push(event);
      continue;
    }
    const key = releaseGroup(event);
    if (!groups.has(key)) groups.set(key, []);
    const group = groups.get(key);
    const duplicate = group.findIndex((saved) => saved.sourceName === event.sourceName &&
      saved.time === event.time && saved.amount === event.amount &&
      (historical || JSON.stringify(saved.allocations) === JSON.stringify(event.allocations)));
    if (duplicate === -1) group.push(event);
    else if (historical && !group[duplicate].allocationComplete && event.allocationComplete) group[duplicate] = event;
  }
  const scheduled = [...groups.values()].flatMap((group) => {
    // A provider can report separate releases of the same type on the same day.
    // Keep the preferred provider's events separate when there is no one-to-one match.
    const names = new Set(group.map((event) => event.sourceName));
    if (names.size < group.length) return group.filter((event) => event.sourceName === group[0].sourceName);
    const votes = group.map((event) => group.filter((other) => compareAmounts(other.amount, event.amount)).length);
    const highest = Math.max(...votes);
    const ranked = group.filter((_, index) => votes[index] === highest);
    const preferred = ranked[0];
    const chosen = ranked.find((event) => event.allocationComplete && compareAmounts(event.amount, preferred.amount)) ?? preferred;
    const sourceChecks = group.filter((event) => event !== chosen).map(({ sourceName, sourceUrl, amount }) => ({
      sourceName, sourceUrl, amount, agrees: compareAmounts(chosen.amount, amount),
    }));
    const priorChecks = (chosen.sourceChecks ?? []).filter((check) =>
      !historical || !sourceChecks.some((source) => check.sourceName === source.sourceName));
    return sourceChecks.length ? [{ ...chosen, sourceChecks: [...priorChecks, ...sourceChecks] }] : [chosen];
  });
  const results = [...scheduled];
  estimates.sort(historical
    ? (a, b) => b.time - a.time || b.periodStart - a.periodStart
    : (a, b) => a.time - b.time);
  for (const estimate of estimates) {
    if (results.some((event) => event.time > estimate.periodStart &&
      (event.periodStart ?? event.time) <= estimate.time)) continue;
    results.push(estimate);
  }
  return results.sort((a, b) => a.time - b.time);
}
