import aliases from "../lib/coin-source-aliases.json" with { type: "json" };
import { allocationGroup, llamaToken, mergeUnlockEvents, releaseGroup, reviewedToken, tokenomistToken, tokenSymbol } from "./unlock-sources.mjs";

function positiveNumber(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseUnlock(row, now) {
  const time = positiveNumber(row.nextUnlocked?.date);
  const amount = positiveNumber(row.nextUnlocked?.tokenAmount);
  if (time === null || time <= now || time > 8.64e15 || amount === null) return [];
  const details = Array.isArray(row.nextUnlockedDetail) ? row.nextUnlockedDetail : [];
  let allocations = details.flatMap((detail) => {
    const name = typeof detail.allocationName === "string" ? detail.allocationName.trim() : "";
    return name ? [{ name, amount: positiveNumber(detail.tokenAmount), group: allocationGroup(name) }] : [];
  });
  const subtotal = allocations.reduce((sum, detail) => sum + (detail.amount ?? 0), 0);
  const tolerance = Math.max(1e-7, amount * 1e-7);
  const known = allocations.length > 0 && allocations.every((detail) => detail.amount !== null);
  const allocationComplete = known && Math.abs(amount - subtotal) <= tolerance;
  if (subtotal > amount + tolerance) {
    allocations = [];
  } else if (known && amount - subtotal > tolerance) {
    allocations.push({ name: "分配用途未披露", amount: amount - subtotal, group: "other" });
  }
  const detailKinds = details.map((detail) => String(detail.vestingType).trim().toLowerCase());
  const kinds = new Set(detailKinds);
  const kind = kinds.size === 1 ? kinds.values().next().value : null;
  const event = {
    symbol: row.symbol.toUpperCase(), time, amount, timeKind: "scheduled",
    mechanism: kind === "cliff" || kind === "linear" ? kind : null,
    allocationComplete, allocations,
    sourceUrl: `https://coinmarketcap.com/currencies/${encodeURIComponent(row.slug)}/#token-unlocks`,
    sourceName: "CoinMarketCap",
  };
  if (allocationComplete && allocations.length === details.length && kinds.size === 2 &&
      kinds.has("cliff") && kinds.has("linear")) {
    return ["cliff", "linear"].map((mechanism) => {
      const breakdown = allocations.filter((_, index) => detailKinds[index] === mechanism);
      return { ...event, mechanism, allocations: breakdown, amount: breakdown.reduce((sum, row) => sum + row.amount, 0) };
    });
  }
  return [event];
}

async function readCurve(id, range, request) {
  const result = await request(`https://api.coinmarketcap.com/data-api/v3/token-unlock/historical?cryptoId=${id}&range=${range}`);
  if (String(result.status?.error_code) !== "0" || !Array.isArray(result.data?.tokenHistory)) return [];
  return result.data.tokenHistory;
}

function curveEvents(history, template, now) {
  const points = new Map();
  for (const row of history) {
    const time = Date.parse(row.time);
    const amount = Number(row.amount);
    if (!Number.isFinite(time) || !Number.isFinite(amount) || amount < 0 || row.amount == null || row.amount === "" || !row.allocationName) continue;
    if (!points.has(time)) points.set(time, new Map());
    points.get(time).set(row.allocationName, { amount, version: row.version });
  }
  const sorted = [...points.entries()].sort(([a], [b]) => a - b);
  const events = [];
  for (let i = 1; i < sorted.length; i++) {
    const [start, previous] = sorted[i - 1];
    const [time, current] = sorted[i];
    if (start < now || current.size !== previous.size) continue;
    const allocations = [];
    let valid = true;
    for (const [name, row] of current) {
      const prior = previous.get(name);
      if (!prior || row.version !== prior.version || row.amount < prior.amount) { valid = false; break; }
      const amount = row.amount - prior.amount;
      if (amount > 1e-6) allocations.push({ name, amount, group: allocationGroup(name) });
    }
    if (!valid || !allocations.length) continue;
    events.push({
      symbol: template.symbol, time, periodStart: start, timeKind: "interval-estimate",
      amount: allocations.reduce((sum, row) => sum + row.amount, 0),
      allocations, allocationComplete: true, mechanism: null,
      sourceName: "CoinMarketCap", sourceUrl: template.sourceUrl,
    });
  }
  return events;
}

async function describeToken(identity, calendar, now, request) {
  const cmcSlug = aliases[identity.geckoId] ?? identity.geckoId;
  const result = await request(`https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail?slug=${encodeURIComponent(cmcSlug)}`);
  const detail = result.data;
  if (String(result.status?.error_code) !== "0" || detail?.slug !== cmcSlug ||
      (detail.symbol?.toUpperCase() !== identity.base.toUpperCase() && detail.symbol?.toUpperCase() !== tokenSymbol(identity))) {
    throw new Error("Token identity mismatch.");
  }
  const stats = detail.statistics ?? {};
  const maxSupply = positiveNumber(stats.maxSupply);
  const totalSupply = positiveNumber(stats.totalSupply);
  const supplyLimit = detail.isInfiniteMaxSupply === 1 ? "unlimited" : maxSupply ? "capped" : "unknown";
  const info = detail.tokenUnlockLatest;
  const rawLocked = info?.tokenLockedAmount ?? calendar?.tokenLockedAmount;
  const lockedAmount = typeof rawLocked === "number" && Number.isFinite(rawLocked) && rawLocked >= 0 ? rawLocked : null;
  const events = parseUnlock({ ...info, slug: detail.slug, symbol: detail.symbol }, now);
  if (!events.length && calendar?.slug === detail.slug && calendar.symbol?.toUpperCase() === detail.symbol.toUpperCase()) {
    events.push(...parseUnlock(calendar, now));
  }
  const sourceUrl = `https://coinmarketcap.com/currencies/${encodeURIComponent(detail.slug)}/#token-unlocks`;
  const template = { symbol: detail.symbol, sourceUrl };
  if (events.length || lockedAmount > 0) {
    const histories = await Promise.all(["1M", "1Y"].map((range) => readCurve(detail.id, range, request).catch(() => [])));
    const estimates = histories.flatMap((history) => curveEvents(history, template, now)).sort((a, b) => a.time - b.time);
    for (const event of estimates) {
      const cutoff = events.at(-1)?.time ?? now;
      if (event.periodStart < cutoff) continue;
      events.push(event);
      if (events.length >= 3) break;
    }
  }
  return {
    symbol: detail.symbol, geckoId: identity.geckoId, cmcSlug, updatedAt: now,
    lockedAmount, maxSupply, supplyLimit,
    percentageSupply: maxSupply ?? totalSupply,
    percentageBasis: maxSupply ? "maxSupply" : totalSupply ? "totalSupply" : null,
    events, sourceUrl, sourceName: "CoinMarketCap",
  };
}

/**
 * @param {{geckoId: string, base: string}} identity
 * @param {{calendar?: object | null, prior?: import("../lib/coin-unlocks").StoredToken | null,
 *   now?: number, onError?: (name: string) => void,
 *   request: (url: string, headers?: Record<string, string>) => Promise<any>}} options
 */
export async function fetchUnlockSnapshot(identity, { calendar = null, prior = null, now = Date.now(), onError, request }) {
  const llamaKey = process.env.DEFILLAMA_API_KEY;
  const tokenomistKey = process.env.TOKENOMIST_API_KEY;
  async function attempt(name, load) {
    try { return await load(); }
    catch { onError?.(name); return null; }
  }
  const slug = encodeURIComponent(identity.geckoId);
  const [cmc, llama, tokenomist] = await Promise.all([
    attempt("CoinMarketCap", () => describeToken(identity, calendar, now, request)),
    llamaKey ? attempt("DefiLlama", async () => llamaToken(await request(
      `https://pro-api.llama.fi/${encodeURIComponent(llamaKey)}/api/emission/${slug}`), identity)) : null,
    tokenomistKey ? attempt("Tokenomist", async () => tokenomistToken(await request(
      `https://api.unlocks.app/v4/unlock/events?tokenId=${slug}&start=${new Date(now).toISOString().slice(0, 10)}`,
      { "x-api-key": tokenomistKey }), identity, identity.geckoId)) : null,
  ]);
  const reviewed = reviewedToken(identity);
  const cmcSlug = aliases[identity.geckoId] ?? identity.geckoId;
  const calendarEvents = !cmc && calendar?.slug === cmcSlug && calendar.symbol?.toUpperCase() === tokenSymbol(identity)
    ? parseUnlock(calendar, now) : [];
  const events = mergeUnlockEvents([
    ...(llama?.events ?? []), ...(reviewed?.events ?? []), ...(tokenomist?.events ?? []), ...(cmc?.events ?? calendarEvents),
  ], now);
  const metadata = cmc ?? prior;
  let token = metadata;
  if (cmc || events.length || (reviewed && !prior)) {
    const previousEvents = prior?.events ?? [];
    const updatedGroups = new Set(events.map((event) => `${event.sourceName}:${releaseGroup(event)}`));
    const carried = previousEvents.filter((event) =>
      ((event.sourceName === "DefiLlama" && !llama) ||
        (event.sourceName === "Tokenomist" && !tokenomist) ||
        (event.sourceName === "CoinMarketCap" && (!cmc || (!cmc.events.length && cmc.lockedAmount !== 0)))) &&
      !updatedGroups.has(`${event.sourceName}:${releaseGroup(event)}`));
    const releases = mergeUnlockEvents([...events, ...carried], now).map((event) => {
      if (event.allocationComplete) return event;
      const known = previousEvents.find((saved) => saved.allocationComplete &&
        saved.sourceName === event.sourceName && saved.time === event.time &&
        saved.mechanism === event.mechanism && saved.amount === event.amount);
      return known ? { ...event, allocations: known.allocations, allocationComplete: true } : event;
    });
    const supply = (reviewed?.maxSupply != null ? reviewed : null) ??
      (cmc?.percentageSupply != null ? cmc : prior ?? metadata) ?? releases[0] ?? reviewed;
    const reviewedCap = reviewed?.maxSupply ?? null;
    token = {
      symbol: tokenSymbol(identity), geckoId: identity.geckoId, cmcSlug: metadata?.cmcSlug,
      lockedAmount: cmc?.lockedAmount ?? prior?.lockedAmount ?? null,
      maxSupply: supply.maxSupply ?? null,
      supplyLimit: reviewedCap !== null ? "capped" : supply.supplyLimit ?? "unknown",
      percentageSupply: reviewedCap ?? supply.percentageSupply ?? null,
      percentageBasis: reviewedCap !== null ? "maxSupply" : supply.percentageBasis ?? null,
      events: releases, sourceName: supply.sourceName, sourceUrl: supply.sourceUrl,
      updatedAt: releases.length && !events.length ? prior?.updatedAt : now,
    };
  }
  return { token, refreshed: Boolean(cmc || events.length) };
}
