"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import type { MarketExchange } from "@/lib/market-lookup";
import { BOOK_REFRESH_MS, summarizeDepthGroup, type OrderBookSnapshot } from "@/lib/order-book";
import styles from "./markets.module.css";

const number = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 9 });
const depthAmount = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function formatDepthAmount(value: number) {
  if (value >= 1_000_000) return `${depthAmount.format(value / 1_000_000)}M`;
  if (value >= 1_000) return `${depthAmount.format(value / 1_000)}K`;
  return depthAmount.format(value);
}
const time = new Intl.DateTimeFormat("zh-CN", { timeStyle: "medium", timeZone: "Asia/Shanghai" });

export function CoinOrderBook({ exchange, symbol }: { exchange: MarketExchange; symbol: string }) {
  const [book, setBook] = useState<OrderBookSnapshot | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const params = new URLSearchParams({ exchange, symbol });
    async function load() {
      try {
        const response = await fetch(apiUrl(`/api/markets/order-book?${params}`), { cache: "no-store", signal: request.signal });
        if (!response.ok) throw new Error("Order book unavailable.");
        const snapshot: OrderBookSnapshot = await response.json();
        if (!request.signal.aborted) { setBook(snapshot); setError(false); }
      } catch {
        if (!request.signal.aborted) setError(true);
      } finally {
        if (!request.signal.aborted) timer = setTimeout(load, BOOK_REFRESH_MS);
      }
    }
    void load();
    return () => { request.abort(); clearTimeout(timer); };
  }, [exchange, symbol]);

  return <details className={`${styles.turnover} ${styles.orderBookDepth}`} open>
    <summary>订单簿深度</summary>
    {error && <p role="status">{book ? "更新失败，以下是上次快照。" : "订单簿暂不可用，正在重试。"}</p>}
    {!book && !error && <p role="status">正在读取订单簿…</p>}
    {book && <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="订单簿深度表"><table aria-label="每 100 档挂单深度">
      <caption>每行 100 档 · 价格和金额单位为 USDT · 北京时间 {time.format(book.time)}（约每 5 秒更新）</caption>
      <thead><tr><th scope="col">买单价区间</th><th scope="col">买单金额</th>
        <th scope="col">卖单价区间</th><th scope="col">卖单金额</th></tr></thead>
      <tbody>{Array.from({ length: 10 }, (_, index) => {
        const start = index * 100;
        const bid = summarizeDepthGroup(book.bids, start);
        const ask = summarizeDepthGroup(book.asks, start);
        return <tr key={start}>
          <td>{bid ? `${number.format(bid.firstPrice)}~${number.format(bid.lastPrice)}` : "—"}</td>
          <td>{bid ? formatDepthAmount(bid.amount) : "—"}</td>
          <td>{ask ? `${number.format(ask.firstPrice)}~${number.format(ask.lastPrice)}` : "—"}</td>
          <td>{ask ? formatDepthAmount(ask.amount) : "—"}</td>
        </tr>;
      })}</tbody>
    </table></div>}
  </details>;
}
