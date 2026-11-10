"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import { FUNDING_HISTORY_LIMIT, FUNDING_REFRESH_MS, type MarketFundingRates } from "@/lib/funding-rates";
import type { MarketExchange } from "@/lib/market-lookup";
import styles from "./markets.module.css";

const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 6, signDisplay: "exceptZero" });
const time = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Shanghai" });

export default function CoinFunding({ exchange, symbol }: { exchange: MarketExchange; symbol: string }) {
  const [data, setData] = useState<MarketFundingRates | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const params = new URLSearchParams({ exchange, symbol });

    async function load() {
      let refreshIn = FUNDING_REFRESH_MS;
      try {
        const response = await fetch(apiUrl(`/api/markets/funding-rates?${params}`), { cache: "no-store", signal: request.signal });
        if (!response.ok) throw new Error("Funding data unavailable.");
        const snapshot: MarketFundingRates = await response.json();
        if (!request.signal.aborted) {
          setData(snapshot);
          setError(false);
          if (snapshot.next) refreshIn = Math.min(refreshIn, Math.max(1_000, snapshot.next.time - Date.now() + 1_000));
        }
      } catch {
        if (!request.signal.aborted) setError(true);
      } finally {
        if (!request.signal.aborted) timer = setTimeout(load, refreshIn);
      }
    }
    void load();
    return () => { request.abort(); clearTimeout(timer); };
  }, [exchange, symbol]);

  const previous = data?.previous;
  const next = data?.next && data.next.time > Date.now() ? data.next : null;
  return <section className={styles.turnover} aria-label="资金费率">
    <h4>资金费率</h4>
    <dl className={styles.metrics}>
      <div><dt>上一次已结算</dt><dd>{previous ? percent.format(previous.rate) : "—"}</dd>
        {previous && <small>{time.format(previous.time)}</small>}</div>
      <div><dt>下一次预计</dt><dd>{next ? percent.format(next.rate) : "—"}</dd>
        {next && <small>{time.format(next.time)}</small>}</div>
    </dl>
    <p className={styles.fundamentalsNote}>北京时间。下一次费率在结算前可能变化。</p>
    {error && <p className={styles.fundamentalsNote} role="status">{data ? "更新失败，暂显示上次获取的记录。" : "暂时无法读取资金费率。"}</p>}
    {!data && !error && <p className={styles.fundamentalsNote} role="status">正在获取资金费率…</p>}
    {data && <details>
      <summary>最近 {FUNDING_HISTORY_LIMIT} 次常规结算{data.history.length < FUNDING_HISTORY_LIMIT ? `（已获取 ${data.history.length} 次）` : ""}</summary>
      {data.history.length > 0 && <div className={styles.tableScroll}>
        <table className={styles.unlockTable}>
          <thead><tr><th scope="col">结算时间</th><th scope="col">资金费率</th></tr></thead>
          <tbody>{data.history.map(({ rate, time: settledAt }) => <tr key={settledAt}>
            <th scope="row">{time.format(settledAt)}</th><td>{percent.format(rate)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </details>}
  </section>;
}
