import { LIQUIDATION_INTERVAL_MS, type LiquidationLevels } from "./liquidation-levels";

export const LIVE_LIQUIDATION_WINDOW_LIMIT = 48;
export const LIVE_RISK_MAX_AGE_MS = 3 * 60_000;
const finishedStatuses = new Set(["FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH"]);

export type LiveLiquidation = {
  id: string;
  time: number;
  side: keyof LiquidationLevels["triggers"];
  price: number;
  quantity: number;
  notional: number;
};

export type AvailableRiskSnapshot = Pick<LiquidationLevels, "asOf" | "triggers"> & { receivedAt: number };
export type ClosedMarkBar = { time: number; low: number; high: number };
export type LiquidationStreamPeriod = { from: number; to?: number };
type TriggeredAmount = { notional: number; lowestPrice: number | null; highestPrice: number | null };
export type LiveWindowEstimate = ClosedMarkBar & {
  snapshotTime: number | null;
  estimated: Record<LiveLiquidation["side"], TriggeredAmount> | null;
  streamComplete: boolean;
};
export type LiveWindowComparison = LiveWindowEstimate & { observed: Record<LiveLiquidation["side"], number> };
export type LiquidationStreamStatus = "connecting" | "connected" | "reconnecting";

export function parseBinanceLiquidation(message: string, symbol: string): LiveLiquidation | null {
  let event;
  try {
    event = JSON.parse(message);
  } catch {
    return null;
  }
  const order = event?.o;
  if (event?.e !== "forceOrder" || order?.s !== symbol ||
    (order.S !== "SELL" && order.S !== "BUY") || !finishedStatuses.has(order.X)) return null;
  const time = order.T;
  const price = Number(order.ap);
  const quantity = Number(order.z);
  const notional = price * quantity;
  if (!Number.isSafeInteger(time) || time <= 0 || time > 8_640_000_000_000_000 ||
    !Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0 ||
    !Number.isFinite(notional) || notional <= 0) return null;
  return { id: JSON.stringify([time, order.S, price, quantity, order.p, order.q]), time,
    side: order.S === "SELL" ? "long" : "short", price, quantity, notional };
}

export function rememberLiveSnapshot(snapshots: Map<number, AvailableRiskSnapshot>, snapshot: AvailableRiskSnapshot) {
  // A snapshot returned after the candle began can already contain its price moves.
  const open = Math.ceil(snapshot.receivedAt / LIQUIDATION_INTERVAL_MS) * LIQUIDATION_INTERVAL_MS;
  if (snapshot.asOf <= open && open - snapshot.asOf <= LIVE_RISK_MAX_AGE_MS) snapshots.set(open, snapshot);
}

export function estimateLiveWindow(bar: ClosedMarkBar, snapshot: AvailableRiskSnapshot | undefined,
  periods: readonly LiquidationStreamPeriod[]): LiveWindowEstimate {
  const streamComplete = periods.some(({ from, to }) => from <= bar.time && (to ?? Infinity) >= bar.time + LIQUIDATION_INTERVAL_MS);
  const reached = (triggers: [number, number][], isReached: (price: number) => boolean) => {
    const amount: TriggeredAmount = { notional: 0, lowestPrice: null, highestPrice: null };
    for (const [price, quantity] of triggers) {
      if (!isReached(price)) continue;
      amount.notional += quantity * price;
      amount.lowestPrice = Math.min(amount.lowestPrice ?? price, price);
      amount.highestPrice = Math.max(amount.highestPrice ?? price, price);
    }
    return amount;
  };
  const estimated = snapshot ? {
    long: reached(snapshot.triggers.long, (price) => bar.low <= price),
    short: reached(snapshot.triggers.short, (price) => bar.high >= price),
  } : null;
  return { ...bar, snapshotTime: snapshot?.asOf ?? null, estimated, streamComplete };
}

export function subscribeBinanceLiquidations(symbol: string, onEvent: (event: LiveLiquidation) => void,
  onStatus: (status: LiquidationStreamStatus) => void) {
  const url = `wss://fstream.binance.com/market/ws/${encodeURIComponent(symbol.toLowerCase())}@forceOrder`;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let handshake: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let stopped = false;

  function reconnect() {
    if (stopped) return;
    onStatus("reconnecting");
    retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempts));
    attempts = Math.min(attempts + 1, 5);
  }

  function connect() {
    let connection: WebSocket;
    try {
      connection = new WebSocket(url);
    } catch {
      reconnect();
      return;
    }
    socket = connection;
    handshake = setTimeout(() => connection.close(), 15_000);
    connection.onopen = () => {
      clearTimeout(handshake);
      attempts = 0;
      onStatus("connected");
    };
    connection.onmessage = ({ data }) => {
      if (typeof data !== "string") return;
      const event = parseBinanceLiquidation(data, symbol);
      if (event) onEvent(event);
    };
    connection.onerror = () => connection.close();
    connection.onclose = () => {
      clearTimeout(handshake);
      reconnect();
    };
  }

  onStatus("connecting");
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(handshake);
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
  };
}
