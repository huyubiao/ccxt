import type { CoinValuation } from "./coin-overview";

export const HOLDER_LIMIT = 200;

type HolderBalance = {
  address: string;
  amount: string;
  label: string | null;
  explorerUrl: string;
};

type HolderSnapshot = {
  status: "available" | "partial" | "unsupported" | "unavailable";
  message: string | null;
  symbol: string;
  chain: string | null;
  tokenAddress: string | null;
  totalAmount: string | null;
  rows: HolderBalance[];
  fetchedAt: number;
  stale: boolean;
  sourceName: string;
  sourceUrl: string | null;
  balanceScope?: string;
  amountsEstimated?: boolean;
};

type HolderMarketCapPercentages = {
  totalMarketCapPercentage: number | null;
  circulatingMarketCapPercentage: number | null;
};

export type HolderConcentration = Omit<HolderSnapshot, "rows"> & HolderMarketCapPercentages & {
  supplyLimit: CoinValuation["supplyLimit"];
  maxSupply: number | null;
  totalMarketCap: number | null;
  rows: (HolderBalance & HolderMarketCapPercentages)[];
};
