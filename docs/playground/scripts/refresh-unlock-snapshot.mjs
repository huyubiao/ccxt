import { execFile } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const aliases = JSON.parse(await readFile(new URL("../lib/coin-source-aliases.json", import.meta.url), "utf8"));
const pageSize = 100;
const output = new URL("../lib/coin-unlock-snapshot.json", import.meta.url);
const temporary = new URL(`${output.href}.${process.pid}.tmp`);

async function read(url) {
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  const { stdout } = await run(curl, ["-fsS", "--max-time", "20", "--retry", "2", "--retry-max-time", "30", url],
    { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return JSON.parse(stdout);
}

async function readPage(page) {
  const url = `https://api.coinmarketcap.com/data-api/v3/token-unlock/listing?start=${page}&limit=${pageSize}`;
  const { status, data } = await read(url);
  if (String(status?.error_code) !== "0" || !Array.isArray(data?.tokenUnlockList)) {
    throw new Error(`CoinMarketCap unlock calendar page ${page} is unavailable.`);
  }
  return data;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function allocationGroup(name) {
  if (/\b(foundation|treasury|dao|ecosystem|liquidity|staking|reserve|market maker)\b/i.test(name)) return "other";
  if (/\b(team|founders?|advisors?|advisers?|investors?|contributors?|employees?|private sale|seed (sale|round))\b/i.test(name)) return "insiders";
  if (/\b(public sale|community sale|user|users|airdrop|individual wallets)\b/i.test(name)) return "users";
  return "other";
}

function parseUnlock(row, now) {
  const time = positiveNumber(row.nextUnlocked?.date);
  const amount = positiveNumber(row.nextUnlocked?.tokenAmount);
  if (time === null || time <= now || time > 8.64e15 || amount === null) return null;
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
  const kinds = new Set(details.map((detail) => String(detail.vestingType).toLowerCase()));
  const kind = kinds.size === 1 ? kinds.values().next().value : null;
  return {
    symbol: row.symbol.toUpperCase(), time, amount, timeKind: "scheduled",
    mechanism: kind === "cliff" || kind === "linear" ? kind : null,
    allocationComplete, allocations,
    sourceUrl: `https://coinmarketcap.com/currencies/${encodeURIComponent(row.slug)}/#token-unlocks`,
    sourceName: "CoinMarketCap",
  };
}

async function readCurve(id, range) {
  const result = await read(`https://api.coinmarketcap.com/data-api/v3/token-unlock/historical?cryptoId=${id}&range=${range}`);
  if (String(result.status?.error_code) !== "0" || !Array.isArray(result.data?.tokenHistory)) return [];
  return result.data.tokenHistory;
}

function curveEvents(history, template, now) {
  const points = new Map();
  for (const row of history) {
    const time = Date.parse(row.time);
    const amount = Number(row.amount);
    if (!Number.isFinite(time) || !Number.isFinite(amount) || amount < 0 || !row.allocationName) continue;
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

async function describeToken(identity, calendar, now) {
  const cmcSlug = aliases[identity.geckoId] ?? identity.geckoId;
  const result = await read(`https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail?slug=${encodeURIComponent(cmcSlug)}`);
  const detail = result.data;
  const base = identity.base.toUpperCase();
  if (String(result.status?.error_code) !== "0" || detail?.slug !== cmcSlug ||
      (detail.symbol?.toUpperCase() !== base && detail.symbol?.toUpperCase() !== base.replace(/^(1000000|100000|10000|1000)/, ""))) {
    throw new Error("Token identity mismatch.");
  }
  const stats = detail.statistics ?? {};
  const maxSupply = positiveNumber(stats.maxSupply);
  const totalSupply = positiveNumber(stats.totalSupply);
  const supplyLimit = detail.isInfiniteMaxSupply === 1 ? "unlimited" : maxSupply ? "capped" : "unknown";
  const info = detail.tokenUnlockLatest;
  const rawLocked = info?.tokenLockedAmount ?? calendar?.tokenLockedAmount;
  const lockedAmount = typeof rawLocked === "number" && Number.isFinite(rawLocked) && rawLocked >= 0 ? rawLocked : null;
  const next = parseUnlock({ ...info, slug: detail.slug, symbol: detail.symbol }, now)
    ?? (calendar && parseUnlock(calendar, now));
  const sourceUrl = `https://coinmarketcap.com/currencies/${encodeURIComponent(detail.slug)}/#token-unlocks`;
  const template = { symbol: detail.symbol, sourceUrl };
  const events = next ? [next] : [];
  if (next || lockedAmount > 0) {
    const histories = await Promise.all(["1M", "1Y"].map((range) => readCurve(detail.id, range).catch(() => [])));
    const estimates = histories.flatMap((history) => curveEvents(history, template, now)).sort((a, b) => a.time - b.time);
    for (const event of estimates) {
      const cutoff = events.at(-1)?.time ?? now;
      if (event.periodStart < cutoff) continue;
      events.push(event);
      if (events.length >= 3) break;
    }
  }
  return {
    ...next, symbol: detail.symbol, geckoId: identity.geckoId, cmcSlug, updatedAt: now,
    lockedAmount, maxSupply, supplyLimit,
    percentageSupply: maxSupply ?? totalSupply,
    percentageBasis: maxSupply ? "maxSupply" : totalSupply ? "totalSupply" : null,
    events, sourceUrl, sourceName: "CoinMarketCap",
  };
}

async function refresh() {
  const [first, { tickers }] = await Promise.all([
    readPage(1),
    read("https://api.coingecko.com/api/v3/derivatives/exchanges/binance_futures?include_tickers=all"),
  ]);
  if (!Array.isArray(tickers) || !tickers.length) throw new Error("CoinGecko contract directory is empty.");
  const pageCount = Math.ceil(Number(first.totalCount) / pageSize);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100) {
    throw new Error("CoinMarketCap returned an invalid page count.");
  }
  const rows = [...first.tokenUnlockList];
  for (let start = 2; start <= pageCount; start += 4) {
    const pages = await Promise.all(Array.from({ length: Math.min(4, pageCount - start + 1) }, (_, i) => readPage(start + i)));
    for (const page of pages) rows.push(...page.tokenUnlockList);
  }
  const identities = new Map();
  for (const row of rows) {
    if (typeof row?.slug !== "string" || typeof row?.symbol !== "string") continue;
    identities.set(`${row.slug}:${row.symbol.toUpperCase()}`, row);
  }
  if (identities.size < Math.max(1, (pageCount - 1) * pageSize - 10)) {
    throw new Error("CoinMarketCap returned an incomplete calendar.");
  }
  const now = Date.now();
  const identitiesByToken = new Map();
  for (const { symbol, target, base, coin_id, contract_type } of tickers) {
    if (target !== "USDT" || contract_type !== "perpetual" || typeof symbol !== "string" ||
        typeof base !== "string" || typeof coin_id !== "string" || !coin_id) continue;
    const key = `${coin_id}:${base.toUpperCase()}`;
    if (!identitiesByToken.has(key)) identitiesByToken.set(key, { geckoId: coin_id, base, symbols: [] });
    identitiesByToken.get(key).symbols.push(symbol);
  }
  const previous = JSON.parse(await readFile(output, "utf8").catch(() => '{"contracts":{}}'));
  const missingOnly = process.argv.includes("--missing-only");
  const selection = process.argv.find((argument) => argument.startsWith("--contracts="))?.split("=")[1];
  const selectedContracts = selection ? new Set(selection.toUpperCase().split(",")) : null;
  const contracts = missingOnly || selectedContracts ? { ...previous.contracts } : {};
  const queue = [...identitiesByToken.entries()].filter(([, identity]) =>
    (!selectedContracts || identity.symbols.some((symbol) => selectedContracts.has(symbol))) &&
    (!missingOnly || identity.symbols.some((symbol) => !previous.contracts[symbol]?.geckoId)));
  if (!queue.length) throw new Error("No matching contracts selected for refresh.");
  const selectedCount = queue.length;
  let completed = 0;
  let failures = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const [key, identity] = queue.shift();
      let token;
      try { token = await describeToken(identity, identities.get(key), now); }
      catch {
        failures++;
        token = identity.symbols.map((symbol) => previous.contracts[symbol]).find(Boolean);
        if (token) token = { ...token, updatedAt: token.updatedAt ?? previous.generatedAt };
      }
      for (const symbol of identity.symbols) {
        if (token) contracts[symbol] = token;
      }
      completed++;
      if (completed % 50 === 0) console.log(`Processed ${completed}/${selectedCount} tokens.`);
    }
  }));
  if (!Object.keys(contracts).length) throw new Error("No verified token details matched the contract directory.");
  const height = Number(await read("https://blockstream.info/api/blocks/tip/height"));
  if (!Number.isSafeInteger(height) || height < 840000) throw new Error("Bitcoin block snapshot unavailable.");
  const blockHeights = { BTCUSDT: { height, time: Date.now(), sourceUrl: "https://blockstream.info" } };
  const ordered = Object.fromEntries(Object.entries(contracts).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(temporary, JSON.stringify({ version: 2, generatedAt: now, blockHeights, contracts: ordered }, null, 2) + "\n", { flag: "wx" });
  await rename(temporary, output);
  console.log(`Saved ${Object.keys(ordered).length} contract details; ${failures} tokens could not be refreshed.`);
}

await refresh();
