import ccxt from "ccxt";
import { positiveNumber } from "./coin-overview";
import { getBinanceBundleCandidate, getBinanceBundledAsset, type ContractDirectory, type MarketInstrument } from "./market-lookup";

export const binanceUsdM = new ccxt.binanceusdm({
  timeout: 8000,
  enableRateLimit: true,
  httpsProxy: process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy,
});

export function canUseContractSupply(instrument: MarketInstrument) {
  // The implied price is per contract unit, which can represent a bundle of tokens.
  return instrument.type === "PERPETUAL" && instrument.base === instrument.coin &&
    !getBinanceBundledAsset(instrument.base) && !getBinanceBundleCandidate(instrument.base) && !/^\d{3,}/.test(instrument.base);
}

export function readContractSupplyValuation(row: { sumOpenInterest?: unknown; sumOpenInterestValue?: unknown; CMCCirculatingSupply?: unknown }) {
  const quantity = positiveNumber(row.sumOpenInterest);
  const notional = positiveNumber(row.sumOpenInterestValue);
  const supply = positiveNumber(row.CMCCirculatingSupply);
  const price = quantity !== null && notional !== null ? positiveNumber(notional / quantity) : null;
  const marketCap = price !== null && supply !== null ? positiveNumber(price * supply) : null;
  return price !== null && marketCap !== null ? { price, marketCap } : null;
}

export async function getContractSupplyValuation(instrument: MarketInstrument) {
  if (!canUseContractSupply(instrument)) return null;
  const rows = await binanceUsdM.fapiDataGetOpenInterestHist({ symbol: instrument.id, period: "5m", limit: 3 });
  const now = Date.now();
  for (const row of [...rows].sort((a, b) => Number(b.timestamp) - Number(a.timestamp))) {
    const time = Number(row.timestamp);
    if (row.symbol !== instrument.id || !Number.isSafeInteger(time) || time < now - 900_000 || time > now) continue;
    const valuation = readContractSupplyValuation(row);
    if (valuation) return { ...valuation, time };
  }
  return null;
}

type ExchangeSymbol = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  marginAsset: string;
  contractType: string;
  status: string;
  onboardDate: number;
};

let snapshot: ContractDirectory | undefined;
let pending: Promise<ContractDirectory> | undefined;

export function getContractDirectory(maxAge = 0): Promise<ContractDirectory> {
  if (pending) return pending;
  if (snapshot && Date.now() - snapshot.updatedAt < maxAge) return Promise.resolve(snapshot);

  pending = refreshDirectory().finally(() => { pending = undefined; });
  return pending;
}

async function refreshDirectory(): Promise<ContractDirectory> {
  const response = await binanceUsdM.fapiPublicGetExchangeInfo();
  if (!Array.isArray(response.symbols)) {
    throw new Error("Binance exchangeInfo did not return a symbol list.");
  }

  // Binance reports traditional finance perpetuals as a separate contract type.
  const contracts = (response.symbols as ExchangeSymbol[])
    .filter((market) =>
      market.status === "TRADING" &&
      market.quoteAsset === "USDT" &&
      market.marginAsset === "USDT" &&
      (market.contractType === "PERPETUAL" || market.contractType === "TRADIFI_PERPETUAL")
    )
    .map((market) => ({
      id: market.symbol,
      base: market.baseAsset,
      quote: market.quoteAsset,
      type: market.contractType,
      onboardAt: market.onboardDate,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  snapshot = { contracts, updatedAt: Date.now() };
  return snapshot;
}
