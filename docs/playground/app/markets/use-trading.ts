"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import { readMarketResponse } from "@/lib/market-response";
import type { TestOrderRequest, Trade, TradingAccountRequest, TradingStatus } from "@/lib/trading-types";

const statusEndpoint = apiUrl("/api/trading");
const POLL_MS = 4000;

async function update<T>(path: string, method: "POST" | "PUT" | "DELETE", body: unknown, message: string): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
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
  const pollRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    if (mode === "unavailable") return;
    const request = new AbortController();
    pollRequest.current = request;
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
      if (pollRequest.current === request) pollRequest.current = null;
    };
  }, [mode, refreshKey]);

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    if (busy.current) throw new Error("上一笔操作还在进行，请稍候。");
    busy.current = true;
    pollRequest.current?.abort();
    try {
      return await work();
    } finally {
      busy.current = false;
      setRefreshKey((key) => key + 1);
    }
  }, []);

  const placeTestOrder = useCallback((request: TestOrderRequest) =>
    run(() => update<{ trade: Trade }>("/api/trading/test-order", "POST", request, "测试策略下单失败。")), [run]);
  const closeTrade = useCallback((tradeId: string) =>
    run(() => update<{ trade: Trade }>("/api/trading/close", "POST", { tradeId }, "平仓失败。")), [run]);
  const deleteTrades = useCallback((tradeIds: readonly string[]) =>
    run(async () => {
      await update("/api/trading", "DELETE", { tradeIds }, "无法删除下单记录。");
      const removed = new Set(tradeIds);
      setData((current) => current && { ...current, trades: current.trades.filter(({ id }) => !removed.has(id)) });
    }), [run]);
  const changeAccount = useCallback((request: TradingAccountRequest) =>
    run(async () => {
      const message = request.action === "login" ? "无法登录币安账号。" : "无法登出币安账号。";
      setData(await update<TradingStatus>("/api/trading/account", "PUT", request, message));
      setError("");
    }), [run]);

  return { mode, data, error, placeTestOrder, closeTrade, deleteTrades, changeAccount };
}
