"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import { CONTRACT_REFRESH_MS, marketKinds, type MarketDirectory, type MarketExchange } from "@/lib/market-lookup";

const CONTRACT_STREAM = "wss://fstream.binance.com/market/ws/!contractInfo";

export function useMarketDirectory(exchange: MarketExchange) {
  const [directory, setDirectory] = useState<MarketDirectory | null>(null);
  const [syncError, setSyncError] = useState(false);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const lifecycle = new AbortController();
    let refreshing = false;
    let refreshAgain = false;
    let changeTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;

    async function refresh() {
      if (lifecycle.signal.aborted) return;
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      try {
        const response = await fetch(apiUrl(`/api/markets/directory?exchange=${exchange}`), {
          cache: "no-store",
          signal: lifecycle.signal,
        });
        if (!response.ok) throw new Error("Market directory refresh failed.");
        const next: MarketDirectory = await response.json();
        if (!lifecycle.signal.aborted) {
          setDirectory((previous) => {
            if (!previous) return next;
            const merged = { ...next };
            for (const kind of marketKinds) {
              if (next[kind].stale && next[kind].updatedAt === null && previous[kind].updatedAt !== null) {
                merged[kind] = { ...previous[kind], stale: true };
              }
            }
            return merged;
          });
          setSyncError(false);
        }
      } catch {
        if (!lifecycle.signal.aborted) setSyncError(true);
      } finally {
        refreshing = false;
        if (refreshAgain) {
          refreshAgain = false;
          void refresh();
        }
      }
    }

    function scheduleRefresh() {
      if (changeTimer !== undefined) return;
      changeTimer = setTimeout(() => {
        changeTimer = undefined;
        void refresh();
      }, 750);
    }

    function connect() {
      const connection = new WebSocket(CONTRACT_STREAM);
      socket = connection;
      connection.onopen = () => {
        setLive(true);
        scheduleRefresh();
      };
      connection.onmessage = ({ data }) => {
        if (typeof data !== "string") return;
        try {
          const event = JSON.parse(data);
          // Binance may also publish COIN-M events on the shared stream.
          if (event?.e === "contractInfo" && event.st !== 2) scheduleRefresh();
        } catch {
          // Ignore malformed frames. The periodic REST refresh still runs.
        }
      };
      connection.onerror = () => connection.close();
      connection.onclose = () => {
        setLive(false);
        reconnectTimer = setTimeout(connect, 10000);
      };
    }

    function refreshOnReturn() {
      if (document.visibilityState === "visible") void refresh();
    }

    const polling = setInterval(refresh, CONTRACT_REFRESH_MS);
    document.addEventListener("visibilitychange", refreshOnReturn);
    void refresh();
    if (exchange === "binance") connect();

    return () => {
      lifecycle.abort();
      clearInterval(polling);
      clearTimeout(changeTimer);
      clearTimeout(reconnectTimer);
      document.removeEventListener("visibilitychange", refreshOnReturn);
      if (socket) {
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
        socket.close();
      }
    };
  }, [exchange]);

  return { directory, syncError, live };
}
