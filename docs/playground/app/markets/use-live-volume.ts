"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import { okxTrade } from "@/lib/external-trades";
import {
  MINUTE_MS, VOLUME_DELAY_MS, parseAggregateTrade, shortPeriods, sumShortVolume,
  type RecentTrade, type RecentVolumeSeed,
} from "@/lib/short-volume";
import type { MarketInstrument, TradeAmounts, VolumeWindow } from "@/lib/market-lookup";

type LiveVolume = { asOf: number; windows: VolumeWindow[]; closedWindows: VolumeWindow[] };
const emptyWindows: VolumeWindow[] = shortPeriods.map(({ period }) => ({ period, amounts: null }));
const closedPeriods = [["5m", 5], ["1h", 60], ["24h", 1440], ["7d", 10080]] as const;
const streamEndpoints = {
  futures: "wss://fstream.binance.com/market/ws",
  spot: "wss://data-stream.binance.vision/ws",
};
const alphaStream = "wss://nbstream.binance.com/w3w/wsa/stream/stream";

export function useLiveVolume(pair: MarketInstrument) {
  const { kind, id: symbol, quote, exchange = "binance", contractSize = 1 } = pair;
  const [volume, setVolume] = useState<LiveVolume | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    const lifecycle = new AbortController();
    const trades = new Map<number, RecentTrade>();
    const alpha = kind === "alpha";
    const external = exchange !== "binance";
    const collectClosed = exchange === "okx" && kind === "spot";
    const closedMinutes = new Map<number, TradeAmounts>();
    let connectedAt = Infinity;
    let archivedBefore = -Infinity;
    let closedAsOf = -Infinity;
    let closedWindows: VolumeWindow[] = [];
    let coveredFrom = -Infinity;
    let seedCutoff: number | undefined;
    let rates: Map<number, number> | null = quote === "USDT" ? null : new Map();
    let socket: WebSocket | undefined;
    let ready = false;
    let bootstrap: ReturnType<typeof setTimeout>;
    let reconnect: ReturnType<typeof setTimeout>;
    let connectTimeout: ReturnType<typeof setTimeout>;
    let ratesTimer: ReturnType<typeof setTimeout>;
    let heartbeat: ReturnType<typeof setInterval>;
    let seedRequest: AbortController | undefined;

    function publish() {
      const end = Date.now() - VOLUME_DELAY_MS;
      const cutoff = end - MINUTE_MS;
      for (const [id, trade] of trades) {
        if (trade.time >= cutoff) continue;
        trades.delete(id);
        if (collectClosed && trade.time >= connectedAt && trade.side) {
          const minute = Math.floor(trade.time / MINUTE_MS) * MINUTE_MS;
          const amounts = closedMinutes.get(minute) ?? { buy: 0, sell: 0 };
          amounts[trade.side] += trade.amount;
          closedMinutes.set(minute, amounts);
        }
      }
      archivedBefore = cutoff;
      if (collectClosed) {
        const asOf = Math.floor(cutoff / MINUTE_MS) * MINUTE_MS;
        if (asOf > closedAsOf) {
          closedAsOf = asOf;
          closedWindows = [];
          const keepFrom = asOf - 10080 * MINUTE_MS;
          for (const minute of closedMinutes.keys()) {
            if (minute < keepFrom) closedMinutes.delete(minute);
          }
          for (const [period, minutes] of closedPeriods) {
            const start = asOf - minutes * MINUTE_MS;
            if (start < connectedAt) continue;
            const amounts = { buy: 0, sell: 0 };
            for (let minute = start; minute < asOf; minute += MINUTE_MS) {
              const row = closedMinutes.get(minute);
              if (row) {
                amounts.buy += row.buy;
                amounts.sell += row.sell;
              }
            }
            closedWindows.push({ period, asOf, amounts, total: amounts.buy + amounts.sell });
          }
        }
      }
      if (ready) setVolume({
        asOf: end, windows: sumShortVolume(trades.values(), end, rates, alpha, coveredFrom), closedWindows,
      });
    }

    async function readView<T>(view: "recent" | "rates", signal: AbortSignal): Promise<T> {
      const params = new URLSearchParams({ exchange, market: kind, symbol, view });
      const response = await fetch(apiUrl(`/api/markets/volume?${params}`), { signal, cache: "no-store" });
      if (!response.ok) throw new Error("Volume synchronization failed.");
      return response.json();
    }

    async function seed(connection: WebSocket) {
      const request = new AbortController();
      seedRequest = request;
      try {
        const data = await readView<RecentVolumeSeed>("recent", request.signal);
        if (request.signal.aborted || connection.readyState !== WebSocket.OPEN) return;
        if (alpha) {
          // Alpha's live stream is individual trades, while REST returns
          // aggregates. Use REST strictly before the cutoff and live after it.
          seedCutoff = data.asOf;
          for (const [id, trade] of trades) {
            if (trade.time < seedCutoff) trades.delete(id);
          }
        }
        for (const trade of data.trades) {
          if (!collectClosed || trade.time >= archivedBefore) trades.set(alpha ? -trade.id - 1 : trade.id, trade);
        }
        const seedCoverage = data.coveredFrom ?? -Infinity;
        if (!external) coveredFrom = seedCoverage;
        else if (data.asOf >= connectedAt) coveredFrom = Math.min(coveredFrom, seedCoverage);
        if (data.rates && rates) {
          for (const [minute, rate] of data.rates) {
            if (!rates.has(minute)) rates.set(minute, rate);
          }
        }
        ready = true;
        setReconnecting(false);
        publish();
      } catch {
        if (!request.signal.aborted && !external) connection.close();
      }
    }

    function connect() {
      const stream = encodeURIComponent(symbol.toLowerCase());
      const url = exchange === "okx" ? "wss://ws.okx.com:8443/ws/v5/business"
        : kind === "alpha" ? alphaStream : `${streamEndpoints[kind]}/${stream}@aggTrade`;
      const connection = new WebSocket(url);
      socket = connection;
      connectTimeout = setTimeout(() => connection.close(), 10000);
      let subscribed = false;
      let lastMessage = Date.now();

      function startSeed() {
        if (subscribed) return;
        subscribed = true;
        clearTimeout(connectTimeout);
        if (external) {
          connectedAt = Date.now();
          coveredFrom = connectedAt;
          ready = true;
          setReconnecting(false);
        }
        // Buffer live trades first. Delay the REST request until its cutoff
        // overlaps the subscription.
        bootstrap = setTimeout(() => void seed(connection), VOLUME_DELAY_MS + 250);
      }

      connection.onopen = () => {
        if (alpha) connection.send(JSON.stringify({ method: "SUBSCRIBE", params: [`${stream}@trade`], id: 1 }));
        else if (exchange === "okx") {
          connection.send(JSON.stringify({ op: "subscribe", args: [{ channel: "trades-all", instId: symbol }] }));
        } else startSeed();
        if (external) heartbeat = setInterval(() => {
          if (Date.now() - lastMessage > 45000) return connection.close();
          if (exchange === "okx") connection.send("ping");
        }, 15000);
      };
      connection.onmessage = ({ data }) => {
        try {
          lastMessage = Date.now();
          if (data === "pong") return;
          const frame = JSON.parse(data);
          if (exchange === "okx") {
            if (frame.event === "error") return connection.close();
            if (frame.event === "subscribe" && frame.arg?.instId === symbol) startSeed();
            if (frame.arg?.instId === symbol && Array.isArray(frame.data)) {
              for (const row of frame.data) {
                const trade = okxTrade(row, contractSize);
                if (!collectClosed || trade.time >= archivedBefore) trades.set(trade.id, trade);
              }
            }
          } else if (alpha) {
            if (frame.id === 1 && frame.result === null) startSeed();
            const event = frame.data;
            if (event?.e !== "trade" || event.s !== symbol) return;
            const trade = parseAggregateTrade({ ...event, a: event.t }, true);
            if (seedCutoff === undefined || trade.time >= seedCutoff) trades.set(trade.id, trade);
          } else if (frame?.e === "aggTrade" && frame.s === symbol && !(kind === "futures" && frame.st === 2)) {
            const trade = parseAggregateTrade(frame);
            trades.set(trade.id, trade);
          }
        } catch {
          // Resynchronize after a malformed trade rather than count a partial window.
          connection.close();
        }
      };
      connection.onerror = () => connection.close();
      connection.onclose = () => {
        clearTimeout(bootstrap);
        clearTimeout(connectTimeout);
        clearInterval(heartbeat);
        seedRequest?.abort();
        ready = false;
        seedCutoff = undefined;
        trades.clear();
        closedMinutes.clear();
        connectedAt = Infinity;
        closedAsOf = -Infinity;
        closedWindows = [];
        setVolume(null);
        setReconnecting(true);
        reconnect = setTimeout(connect, 5000);
      };
    }

    async function refreshRates() {
      try {
        const data = await readView<{ rates: RecentVolumeSeed["rates"] }>("rates", lifecycle.signal);
        if (data.rates) rates = new Map(data.rates);
      } catch {
        // Retain the last available rates until the next update.
      } finally {
        if (!lifecycle.signal.aborted) ratesTimer = setTimeout(refreshRates, 5000);
      }
    }

    const ticker = setInterval(publish, 1000);
    connect();
    if (rates) ratesTimer = setTimeout(refreshRates, 5000);

    return () => {
      lifecycle.abort();
      seedRequest?.abort();
      clearInterval(ticker);
      clearInterval(heartbeat);
      clearTimeout(bootstrap);
      clearTimeout(reconnect);
      clearTimeout(connectTimeout);
      clearTimeout(ratesTimer);
      if (socket) {
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
        socket.close();
      }
    };
  }, [exchange, kind, symbol, quote, contractSize]);

  return { asOf: volume?.asOf, windows: volume?.windows ?? emptyWindows, closedWindows: volume?.closedWindows ?? [], reconnecting };
}
