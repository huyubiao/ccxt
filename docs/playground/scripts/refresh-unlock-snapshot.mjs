import { execFile } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
import { promisify } from "node:util";
import { fetchUnlockSnapshot } from "./fetch-unlock-snapshot.mjs";
import { tokenSymbol } from "./unlock-sources.mjs";
import aliases from "../lib/coin-source-aliases.json" with { type: "json" };

const run = promisify(execFile);
const pageSize = 100;
const output = new URL("../lib/coin-unlock-snapshot.json", import.meta.url);
const temporary = new URL(`${output.href}.${process.pid}.tmp`);

async function read(url, headers = {}) {
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  const request = run(curl, ["-fsS", "--max-time", "20", "--retry", "2", "--retry-max-time", "30", "--config", "-"],
    { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  request.child.stdin.on("error", () => {});
  request.child.stdin.end([["url", url], ...Object.entries(headers).map(([key, value]) => ["header", `${key}: ${value}`])]
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join(""));
  const { stdout } = await request;
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

async function readCalendar() {
  const first = await readPage(1);
  const pageCount = Math.ceil(Number(first.totalCount) / pageSize);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100) {
    throw new Error("CoinMarketCap returned an invalid page count.");
  }
  const rows = [...first.tokenUnlockList];
  for (let start = 2; start <= pageCount; start += 4) {
    const pages = await Promise.all(Array.from({ length: Math.min(4, pageCount - start + 1) },
      (_, i) => readPage(start + i).catch(() => null)));
    for (const page of pages) if (page) rows.push(...page.tokenUnlockList);
  }
  const identities = new Map();
  for (const row of rows) {
    if (typeof row?.slug !== "string" || typeof row?.symbol !== "string") continue;
    identities.set(`${row.slug}:${row.symbol.toUpperCase()}`, row);
  }
  return identities;
}

async function refresh() {
  const previous = JSON.parse(await readFile(output, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return '{"contracts":{}}';
  }));
  const missingOnly = process.argv.includes("--missing-only");
  const selection = process.argv.find((argument) => argument.startsWith("--contracts="))?.split("=")[1];
  const selectedContracts = selection ? new Set(selection.toUpperCase().split(",")) : null;
  const [calendar, directory] = await Promise.all([
    readCalendar().catch(() => {
      console.warn("CoinMarketCap calendar unavailable; continuing with token details and other sources.");
      return new Map();
    }),
    read("https://api.coingecko.com/api/v3/derivatives/exchanges/binance_futures?include_tickers=all").catch(() => null),
  ]);
  let tickers = directory?.tickers;
  const cachedDirectory = !Array.isArray(tickers) || !tickers.length;
  if (cachedDirectory) {
    console.warn("CoinGecko directory unavailable; using previously verified contract identities.");
    tickers = Object.entries(previous.contracts).map(([symbol, row]) => ({
      symbol, coin_id: row.geckoId, base: symbol.replace(/USDT$/, ""), target: "USDT", contract_type: "perpetual",
    }));
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
  const contracts = { ...previous.contracts };
  const queue = [...identitiesByToken.entries()].filter(([, identity]) =>
    (!selectedContracts || identity.symbols.some((symbol) => selectedContracts.has(symbol))) &&
    (!missingOnly || identity.symbols.some((symbol) => !previous.contracts[symbol]?.geckoId)));
  if (!queue.length) throw new Error("No matching contracts selected for refresh.");
  const selectedCount = queue.length;
  let completed = 0;
  let failures = 0;
  const errors = { CoinMarketCap: 0, DefiLlama: 0, Tokenomist: 0 };
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const [, identity] = queue.shift();
      const calendarKey = `${aliases[identity.geckoId] ?? identity.geckoId}:${tokenSymbol(identity)}`;
      const prior = identity.symbols.map((symbol) => previous.contracts[symbol]).find((row) => row?.geckoId === identity.geckoId);
      const { token, refreshed } = await fetchUnlockSnapshot(identity, {
        calendar: calendar.get(calendarKey), prior: prior && { ...prior, updatedAt: prior.updatedAt ?? previous.generatedAt },
        now, request: read, onError: (name) => { errors[name]++; },
      });
      if (!refreshed) failures++;
      for (const symbol of identity.symbols) {
        if (token && (!selectedContracts || selectedContracts.has(symbol))) contracts[symbol] = token;
      }
      completed++;
      if (completed % 50 === 0) console.log(`Processed ${completed}/${selectedCount} tokens.`);
    }
  }));
  if (!Object.keys(contracts).length) throw new Error("No verified token details matched the contract directory.");
  const blockHeights = { ...previous.blockHeights };
  if (!selectedContracts || selectedContracts.has("BTCUSDT")) {
    const height = Number(await read("https://blockstream.info/api/blocks/tip/height").catch(() => null));
    if (Number.isSafeInteger(height) && height >= 840000) {
      blockHeights.BTCUSDT = { height, time: Date.now(), sourceUrl: "https://blockstream.info" };
    } else {
      console.warn("Bitcoin block height unavailable; retaining the previous height if present.");
    }
  }
  const ordered = Object.fromEntries(Object.entries(contracts).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(temporary, JSON.stringify({ version: 2, generatedAt: now, blockHeights, contracts: ordered }, null, 2) + "\n", { flag: "wx" });
  await rename(temporary, output);
  console.log(`Saved ${Object.keys(ordered).length} contract details; ${failures} tokens could not be refreshed.`);
  for (const [name, count] of Object.entries(errors)) if (count) console.warn(`${name}: ${count} requests failed.`);
}

await refresh();
