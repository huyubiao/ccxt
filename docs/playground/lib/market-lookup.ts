export const CONTRACT_REFRESH_MS = 15000;

export type FuturesContract = {
  id: string;
  base: string;
  quote: string;
  type: string;
  onboardAt: number;
};

export type ContractDirectory = {
  contracts: FuturesContract[];
  updatedAt: number;
};

export const marketKinds = ["futures", "spot", "alpha"] as const;
export type MarketKind = (typeof marketKinds)[number];
export const marketExchanges = ["binance", "okx"] as const;
export type MarketExchange = (typeof marketExchanges)[number];
export const exchangeLabels: Record<MarketExchange, string> = { binance: "币安", okx: "OKX" };

export function parseMarketExchange(value: string | null): MarketExchange | undefined {
  return value === null ? "binance" : marketExchanges.find((exchange) => exchange === value);
}

export function parseMarketKind(value: string | null): MarketKind | undefined {
  return value === null ? "futures" : marketKinds.find((kind) => kind === value);
}

export type MarketInstrument = FuturesContract & {
  kind: MarketKind;
  coin: string;
  exchange?: MarketExchange;
  contractSize?: number;
  name?: string;
  chain?: string;
  address?: string;
};

export type MarketListing = {
  instruments: MarketInstrument[];
  updatedAt: number | null;
  stale: boolean;
};

export type MarketDirectory = Record<MarketKind, MarketListing>;

export type MarketQuote = {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  changePercent: number | null;
  baseVolume: number | null;
  timestamp: number | null;
  fetchedAt: number;
};

export type TradeAmounts = { buy: number; sell: number };

export type VolumeWindow = {
  period: "5s" | "30s" | "1m" | "5m" | "1h" | "24h" | "7d";
  amounts: TradeAmounts | null;
  total?: number | null;
  asOf?: number;
};

export type MarketVolume = {
  symbol: string;
  asOf: number;
  shortAsOf: number;
  convertedFrom: string | null;
  windows: VolumeWindow[];
};
