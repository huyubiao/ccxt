import type { MarginBracket, MarginProfile } from "./liquidation-levels";

export const BINANCE_MARGIN_BRACKETS_URL = "https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets";
export const BINANCE_MARGIN_UNAVAILABLE_MESSAGE = "暂未取得该合约完整的币安保证金档位，请稍后重试。";
const HOUR_MS = 60 * 60_000;
const RETRY_MS = 60_000;
const MAX_AGE_MS = 24 * HOUR_MS;

export class BinanceMarginProfileUnavailableError extends Error {
  constructor(symbol: string) {
    super(`Binance margin brackets unavailable for ${symbol}.`);
  }
}

type BinanceRiskBracket = {
  bracketNotionalFloor?: unknown;
  bracketNotionalCap?: unknown;
  bracketMaintenanceMarginRate?: unknown;
  cumFastMaintenanceAmount?: unknown;
  maxOpenPosLeverage?: unknown;
};

type BinanceMarginTable = {
  success?: boolean;
  data?: { brackets?: { symbol?: unknown; riskBrackets?: BinanceRiskBracket[] }[] };
};

type CompleteProfile = MarginProfile & { brackets: MarginBracket[]; fetchedAt: number };

function numberFrom(value: unknown) {
  if (typeof value === "number") return value;
  return typeof value === "string" && value.trim() ? Number(value) : NaN;
}

export function readBinanceMarginProfiles(payload: unknown, fetchedAt: number) {
  const table = payload as BinanceMarginTable | null;
  if (table?.success !== true || !Array.isArray(table.data?.brackets)) {
    throw new Error("Invalid Binance margin table.");
  }
  const profiles = new Map<string, CompleteProfile>();
  for (const row of table.data.brackets) {
    if (typeof row?.symbol !== "string" || !row.symbol || !Array.isArray(row.riskBrackets) || !row.riskBrackets.length) continue;
    const brackets = row.riskBrackets.map((bracket) => ({
      floor: numberFrom(bracket?.bracketNotionalFloor),
      cap: numberFrom(bracket?.bracketNotionalCap),
      rate: numberFrom(bracket?.bracketMaintenanceMarginRate),
      deduction: numberFrom(bracket?.cumFastMaintenanceAmount),
      maxLeverage: numberFrom(bracket?.maxOpenPosLeverage),
    })).sort((a, b) => a.floor - b.floor);
    const first = brackets[0];
    const complete = brackets.every((bracket, index) => Object.values(bracket).every(Number.isFinite) &&
      bracket.floor === (brackets[index - 1]?.cap ?? 0) && bracket.cap > bracket.floor &&
      bracket.rate >= 0 && bracket.rate < 1 && bracket.deduction >= 0 &&
      Number.isSafeInteger(bracket.maxLeverage) && bracket.maxLeverage >= 1);
    if (!complete || first.rate >= 1 / first.maxLeverage) continue;
    profiles.set(row.symbol, { maxLeverage: first.maxLeverage, maintenanceRate: first.rate, notionalCap: first.cap, brackets, fetchedAt });
  }
  if (!profiles.size) throw new Error("Binance margin table has no complete schedules.");
  return profiles;
}

export function createBinanceMarginProfileLoader(request: () => Promise<unknown>, clock = Date.now) {
  const profiles = new Map<string, CompleteProfile>();
  let nextAttempt = -Infinity;
  let pending: Promise<void> | undefined;

  async function refresh() {
    try {
      const response = await request();
      const now = clock();
      const current = readBinanceMarginProfiles(response, now);
      for (const [symbol, profile] of profiles) {
        if (now - profile.fetchedAt >= MAX_AGE_MS) profiles.delete(symbol);
      }
      // A partial reply must not replace a valid schedule for an omitted symbol.
      for (const [symbol, profile] of current) profiles.set(symbol, profile);
    } catch {
      // Keep the last validated exchange schedule until its age limit.
    } finally {
      nextAttempt = clock() + RETRY_MS;
    }
  }

  return async (symbol: string): Promise<CompleteProfile> => {
    const cached = profiles.get(symbol);
    if (cached && clock() - cached.fetchedAt < HOUR_MS) return cached;
    // A new symbol can request a refresh before existing entries reach their TTL.
    if (!pending && clock() >= nextAttempt) pending = refresh().finally(() => { pending = undefined; });
    if (pending) await pending;
    const profile = profiles.get(symbol);
    if (!profile || clock() - profile.fetchedAt >= MAX_AGE_MS) throw new BinanceMarginProfileUnavailableError(symbol);
    return profile;
  };
}
