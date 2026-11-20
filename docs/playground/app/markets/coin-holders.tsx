"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import { HOLDER_LIMIT, type HolderConcentration } from "@/lib/holder-concentration";
import { marketNumberFormatter } from "@/lib/market-number";
import styles from "./markets.module.css";

const amountFormat = marketNumberFormatter({ maximumSignificantDigits: 12 });
const percentageFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 });
const timeFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" });

function percentage(value: number | null, estimated?: boolean) {
  return value === null ? "—" : `${estimated ? "约 " : ""}${percentageFormat.format(value)}%`;
}

export default function CoinHolders({ symbol }: { symbol: string }) {
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<HolderConcentration | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!attempt) return;
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    const params = new URLSearchParams({ symbol });
    void fetch(apiUrl(`/api/markets/holders?${params}`), { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Holder data unavailable.");
        const next: HolderConcentration = await response.json();
        if (!controller.signal.aborted) setData(next);
      }).catch(() => {
        if (!controller.signal.aborted) setError(true);
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [symbol, attempt]);

  const count = data?.rows.length ?? 0;
  const unlimited = data?.supplyLimit === "unlimited";
  const shareLabel = unlimited ? "占流通市值" : "占总市值";
  const share = unlimited ? "circulatingMarketCapPercentage" : "totalMarketCapPercentage";
  return <section className={styles.holderBlock} aria-label="持币集中度">
    <h4>持币集中度 · 前 {count || HOLDER_LIMIT} 地址</h4>
    <p className={styles.fundamentalsNote}>有供应上限时，持仓市值除以总市值。无供应上限时，持仓市值除以流通市值。</p>
    <button className={styles.holderButton} type="button" disabled={loading} onClick={() => setAttempt((value) => value + 1)}>
      {loading ? "正在统计…" : attempt ? "重新读取统计" : "统计前 200 地址"}
    </button>
    {error && <p className={styles.fundamentalsNote} role="status">持币资料请求失败，请稍后重试。</p>}
    {data?.message && <p className={styles.fundamentalsNote} role="status">{data.message}</p>}
    {data && count > 0 && <>
      <dl className={styles.metrics}>
        <div><dt>已统计地址数</dt><dd>{count} / {HOLDER_LIMIT}</dd></div>
        <div><dt>前 {count} 地址合计持仓</dt><dd>{data.amountsEstimated && "约 "}{data.totalAmount === null ? "—" : amountFormat(Number(data.totalAmount))} {data.symbol}</dd></div>
        <div><dt>前 {count} 地址{shareLabel}</dt><dd>{percentage(data[share], data.amountsEstimated)}</dd></div>
        <div><dt>最大供应量</dt><dd>{unlimited ? "无上限" : data.maxSupply === null ? "—" : `${amountFormat(data.maxSupply)} ${data.symbol}`}</dd></div>
      </dl>
      {!unlimited && data.maxSupply === null && <p className={styles.fundamentalsNote}>币种暂未核实供应上限，因此只展示持仓量。</p>}
      <p className={styles.fundamentalsNote}>统计范围 {data.chain}{data.tokenAddress ? ` · 合约 ${data.tokenAddress}` : " · 原生币"}。
        快照获取于 {timeFormat.format(data.fetchedAt)}。{data.stale && " 当前为上次保存的快照。"}
      </p>
      {data.balanceScope && <p className={styles.fundamentalsNote}>{data.balanceScope}</p>}
      <details>
        <summary>查看前 {count} 个地址明细</summary>
        <div className={`${styles.tableScroll} ${styles.holderScroll}`}>
          <table className={styles.unlockTable}>
            <thead><tr><th scope="col">排名 / 地址</th><th scope="col">持仓量 ({data.symbol})</th><th scope="col">{shareLabel}</th></tr></thead>
            <tbody>{data.rows.map((row, index) => <tr key={row.address}>
              <th scope="row">
                {index + 1}. <a className={styles.fundamentalsLink} href={row.explorerUrl} target="_blank" rel="noreferrer">{row.address}</a>
                {row.label && <small>{row.label}</small>}
              </th>
              <td title={row.amount}>{data.amountsEstimated && "约 "}{amountFormat(Number(row.amount))}</td><td>{percentage(row[share], data.amountsEstimated)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>
      {data.sourceUrl && <p className={styles.fundamentalsNote}>
        <a className={styles.fundamentalsLink} href={data.sourceUrl} target="_blank" rel="noreferrer">{data.sourceName} 地址来源</a>
      </p>}
      <p className={styles.fundamentalsNote}>
        地址可能属于交易所、托管方、锁仓、销毁或其他合约。同一持有人也可能使用多个地址。
        地址统计限于上述单链，市值采用整个币种的数据。
      </p>
    </>}
    {!attempt && <p className={styles.fundamentalsNote}>点击后获取一次，成功结果缓存 6 小时。支持情况取决于该链的数据源。</p>}
  </section>;
}
