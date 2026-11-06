import ccxt from "ccxt";
import type { ContractDirectory } from "./market-lookup";

export const binanceUsdM = new ccxt.binanceusdm({
  timeout: 8000,
  enableRateLimit: true,
  httpsProxy: process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy,
});

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
