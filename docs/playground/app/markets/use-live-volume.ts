"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import { coinbasePerpetualTrade, coinbaseSpotTrade, okxTrade } from "@/lib/external-trades";
import {
  MINUTE_MS, VOLUME_DELAY_MS, parseAggregateTrade, shortPeriods, sumShortVolume,
  type RecentTrade, type RecentVolumeSeed,
} from "@/lib/short-volume";
import type { MarketInstrument, VolumeWindow } from "@/lib/market-lookup";

type LiveVolume = { asOf: number; windows: VolumeWindow[] };
const emptyWindows: VolumeWindow[] = shortPeriods.map(({ period }) => ({ period, amounts: null }));
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
    const coinbasePerpetual = exchange === "coinbase" && kind === "futures";
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
      for (const [id, trade] of trades) {
        if (trade.time < end - MINUTE_MS) trades.delete(id);
      }
      if (ready) setVolume({ asOf: end, windows: sumShortVolume(trades.values(), end, rates, alpha, coveredFrom) });
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
        for (const trade of data.trades) trades.set(alpha ? -trade.id - 1 : trade.id, trade);
        coveredFrom = data.coveredFrom ?? -Infinity;
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
        : coinbasePerpetual ? "wss://www.deribit.com/ws/api/v2"
        : exchange === "coinbase" ? "wss://ws-feed.exchange.coinbase.com"
        : kind === "alpha" ? alphaStream : `${streamEndpoints[kind]}/${stream}@aggTrade`;
      const connection = new WebSocket(url);
      socket = connection;
      connectTimeout = setTimeout(() => connection.close(), 10000);
      let subscribed = false;
      let lastMessage = Date.now();
      let lastCoinbaseTradeId: number | undefined;

      function startSeed() {
        if (subscribed) return;
        subscribed = true;
        clearTimeout(connectTimeout);
        if (external) {
          coveredFrom = Date.now();
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
        } else if (coinbasePerpetual) {
          connection.send(JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "public/subscribe", params: { channels: [`trades.${symbol}.100ms`] },
          }));
        } else if (exchange === "coinbase") {
          connection.send(JSON.stringify({ type: "subscribe", product_ids: [symbol], channels: ["matches", "heartbeat"] }));
        } else startSeed();
        if (external) heartbeat = setInterval(() => {
          if (Date.now() - lastMessage > 45000) return connection.close();
          if (exchange === "okx") connection.send("ping");
          if (coinbasePerpetual) connection.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "public/test" }));
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
                trades.set(trade.id, trade);
              }
            }
          } else if (coinbasePerpetual) {
            if (frame.id === 1 && frame.error) return connection.close();
            if (frame.id === 1 && frame.result?.includes(`trades.${symbol}.100ms`)) startSeed();
            if (frame.params?.channel === `trades.${symbol}.100ms` && Array.isArray(frame.params.data)) {
              for (const row of frame.params.data) {
                const trade = coinbasePerpetualTrade(row);
                trades.set(trade.id, trade);
              }
            }
          } else if (exchange === "coinbase") {
            if (frame.type === "error") return connection.close();
            if (frame.type === "subscriptions") startSeed();
            if (frame.type === "match" && frame.product_id === symbol) {
              const trade = coinbaseSpotTrade(frame);
              if (lastCoinbaseTradeId !== undefined && trade.id > lastCoinbaseTradeId + 1) {
                return connection.close();
              }
              lastCoinbaseTradeId = Math.max(lastCoinbaseTradeId ?? trade.id, trade.id);
              trades.set(trade.id, trade);
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

  return { asOf: volume?.asOf, windows: volume?.windows ?? emptyWindows, reconnecting };
}
