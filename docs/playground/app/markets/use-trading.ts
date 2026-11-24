"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import { readMarketResponse } from "@/lib/market-response";
import type { TestOrderRequest, Trade, TradingStatus } from "@/lib/trading-types";

const statusEndpoint = apiUrl("/api/trading");
const POLL_MS = 4000;

async function post<T>(path: string, body: unknown, message: string): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    // Entry plus two protective orders can take a few seconds on a slow network.
    signal: AbortSignal.timeout(45_000),
  });
  return readMarketResponse<T>(response, message);
}

/** Polls the execution engine; only available in local settings mode. */
export function useTrading() {
  const [mode, setMode] = useState<"loading" | "local" | "unavailable">("loading");
  const [data, setData] = useState<TradingStatus | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const busy = useRef(false);

  useEffect(() => {
    if (mode === "unavailable") return;
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(statusEndpoint, {
          cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
        });
        if (request.signal.aborted) return;
        if (response.status === 403) {
          setMode("unavailable");
          return;
        }
        const status = await readMarketResponse<TradingStatus>(response, "无法读取下单状态。");
        if (request.signal.aborted) return;
        setMode("local");
        setData(status);
        setError("");
      } catch (caught) {
        if (!request.signal.aborted) setError(caught instanceof Error ? caught.message : "无法读取下单状态。");
      }
      if (!request.signal.aborted) timer = setTimeout(poll, POLL_MS);
    }
    void poll();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [mode, refreshKey]);

  const run = useCallback(async (work: () => Promise<{ trade: Trade }>) => {
    if (busy.current) throw new Error("上一笔操作还在进行，请稍候。");
    busy.current = true;
    try {
      const { trade } = await work();
      return trade;
    } finally {
      busy.current = false;
      setRefreshKey((key) => key + 1);
    }
  }, []);

  const placeTestOrder = useCallback((request: TestOrderRequest) =>
    run(() => post("/api/trading/test-order", request, "测试策略下单失败。")), [run]);
  const closeTrade = useCallback((tradeId: string) =>
    run(() => post("/api/trading/close", { tradeId }, "平仓失败。")), [run]);

  return { mode, data, error, placeTestOrder, closeTrade };
}
