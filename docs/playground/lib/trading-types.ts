/** Mirrors `market-service/src/trading.rs`. */
export type TradingMode = "off" | "demo" | "live";
export type TradeSide = "long" | "short";
export type TradeStatus = "opening" | "open" | "closing" | "closed" | "failed";
export const STANDARD_TAKER_FEE_RATE = 0.0005;

export type TradeExecution = { filled: number; quote: number };

export type TradeOrder = {
  kind: "entry" | "add-entry" | "stop-loss" | "take-profit" | "exit" | "limit-exit";
  side: "buy" | "sell";
  amount: number;
  triggerPrice: number | null;
  limitPrice?: number | null;
  exchangeId: string | null;
  average: number | null;
  execution?: TradeExecution | null;
  status: "placed" | "filled" | "canceled" | "triggered" | "failed";
  error: string | null;
  time: number;
};

export type Trade = {
  id: string;
  strategy: { id: string; name: string };
  mode: TradingMode;
  symbol: string;
  unifiedSymbol: string;
  side: TradeSide;
  amount: number;
  notional: number;
  leverage: number;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  stopLossPercent: number;
  takeProfitPercent: number;
  pendingLimitExitPercent?: number;
  deadline: number;
  status: TradeStatus;
  openedAt: number;
  closedAt: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  error: string | null;
  note: string;
  orders: TradeOrder[];
};

export type TradingBalance = {
  asset: "USDT";
  available: number | null;
  total: number | null;
  unrealizedPnl: number | null;
  time: number;
} | { error: string };

export type TradingStatus = {
  mode: TradingMode;
  accountRevision: string;
  enabled: boolean;
  problem: string | null;
  limits: { maxNotional: number; maxOpenTrades: number; maxLeverage: number };
  balance: TradingBalance | null;
  trades: Trade[];
};

export type TestOrderRequest = {
  symbol: string;
  accountRevision: string;
  direction: TradeSide;
  notional: number;
  leverage: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  holdMinutes: number;
};

export type TradingLoginMode = Exclude<TradingMode, "off">;

export type PositionAction =
  | { action: "limit-close"; price: number }
  | { action: "cancel-limit-close" }
  | { action: "set-protection"; stopLossPrice?: number; takeProfitPrice?: number };

export type PositionRequest = PositionAction & { tradeId: string; accountRevision: string };

export type TradingAccountRequest = {
  action: "login";
  mode: TradingLoginMode;
  apiKey: string;
  secret: string;
  confirmLive: boolean;
} | { action: "logout"; accountRevision: string };

export const tradingModeLabels: Record<TradingMode, string> = { off: "未开启", demo: "模拟盘", live: "实盘" };

export function isTradeActive(trade: Pick<Trade, "status">) {
  return trade.status === "opening" || trade.status === "open" || trade.status === "closing";
}

export function tradeExecution(trade: Pick<Trade, "side" | "orders">) {
  const entry = { filled: 0, quote: 0 };
  const exit = { filled: 0, quote: 0 };
  for (const order of trade.orders) {
    const execution = order.execution;
    if (!execution || !Number.isFinite(execution.filled) || !Number.isFinite(execution.quote) ||
        execution.filled <= 0 || execution.quote <= 0) continue;
    const leg = order.kind === "entry" || order.kind === "add-entry" ? entry : exit;
    leg.filled += execution.filled;
    leg.quote += execution.quote;
  }
  const entryFee = entry.filled > 0 ? entry.quote * STANDARD_TAKER_FEE_RATE : null;
  const exitFee = exit.filled > 0 ? exit.quote * STANDARD_TAKER_FEE_RATE : null;
  const sign = trade.side === "long" ? 1 : -1;
  const complete = Math.abs(entry.filled - exit.filled) <= Math.max(entry.filled, exit.filled) * 1e-8;
  return {
    entryPrice: entry.filled > 0 ? entry.quote / entry.filled : null,
    exitPrice: exit.filled > 0 ? exit.quote / exit.filled : null,
    entryFee,
    exitFee,
    netPnl: complete && entryFee !== null && exitFee !== null
      ? (exit.quote - entry.quote) * sign - entryFee - exitFee : null,
  };
}
