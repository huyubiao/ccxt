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

// Keep Binance's grouping keys for assets whose spot or Alpha ticker also includes the bundle.
const bundledAssets = new Map<string, { coin: string; symbol: string; geckoId: string }>([
  ["1000SHIB", { coin: "SHIB", symbol: "SHIB", geckoId: "shiba-inu" }],
  ["1000XEC", { coin: "XEC", symbol: "XEC", geckoId: "ecash" }],
  ["1000LUNC", { coin: "LUNC", symbol: "LUNC", geckoId: "terra-luna" }],
  ["1000PEPE", { coin: "PEPE", symbol: "PEPE", geckoId: "pepe" }],
  ["1000FLOKI", { coin: "FLOKI", symbol: "FLOKI", geckoId: "floki" }],
  ["1000BONK", { coin: "BONK", symbol: "BONK", geckoId: "bonk" }],
  ["1000000MOG", { coin: "MOG", symbol: "MOG", geckoId: "mog-coin" }],
  ["1000CAT", { coin: "1000CAT", symbol: "CAT", geckoId: "simons-cat" }],
  ["1000CHEEMS", { coin: "1000CHEEMS", symbol: "CHEEMS", geckoId: "cheems-token" }],
  ["1000SATS", { coin: "1000SATS", symbol: "SATS", geckoId: "sats-ordinals" }],
  ["1000RATS", { coin: "1000RATS", symbol: "RATS", geckoId: "rats" }],
  ["1MBABYDOGE", { coin: "1MBABYDOGE", symbol: "BABYDOGE", geckoId: "baby-doge-coin" }],
]);

export function getBinanceBundledAsset(base: string) {
  return bundledAssets.get(base.toUpperCase());
}

export function getBinanceBundleCandidate(base: string) {
  return /^(?:10{3,}|[1-9]\d*[KM])([A-Z][A-Z0-9]*)$/.exec(base.toUpperCase())?.[1];
}

export function getContractCoins(
  contracts: readonly Pick<MarketInstrument, "id" | "coin">[],
  symbols?: { has(symbol: string): boolean },
): Set<string> {
  const coins = new Set<string>();
  for (const { id, coin } of contracts) {
    if (!symbols || symbols.has(id)) coins.add(coin);
  }
  return coins;
}

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
