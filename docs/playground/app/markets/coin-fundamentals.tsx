"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import type { CoinOverview, CoinUnlock, UnlockAllocation } from "@/lib/coin-overview";
import styles from "./markets.module.css";

const dollars = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const tokens = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 });
const time = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
});

function usd(amount: number | null) {
  return amount == null ? "—" : `${dollars.format(amount)} USD`;
}

const groups: { id: UnlockAllocation["group"]; title: string }[] = [
  { id: "insiders", title: "团队与投资方" },
  { id: "users", title: "公开销售与用户" },
  { id: "other", title: "其他或未分类" },
];

function Allocation({ unlock, price }: { unlock: CoinUnlock; price: number | null }) {
  const { symbol: coin, allocationComplete } = unlock;

  return (
    <>
      <dl className={styles.metrics}>
        <div><dt>{unlock.mechanism === "linear" ? "下次计划释放（线性）" : "下次计划解锁"}</dt>
          <dd><time dateTime={new Date(unlock.time).toISOString()}>{time.format(unlock.time)}</time></dd></div>
        <div><dt>解锁数量</dt><dd>{tokens.format(unlock.amount)} {coin}</dd></div>
        <div><dt>解锁估值</dt><dd>{usd(price === null ? null : unlock.amount * price)}</dd></div>
      </dl>
      {unlock.allocations.length > 0 ? (
        <div className={styles.tableScroll}>
          <table className={styles.unlockTable}>
            <thead><tr><th scope="col">分配对象</th><th scope="col">数量（{coin}）</th><th scope="col">估值（USD）</th></tr></thead>
            <tbody>
              {groups.map(({ id, title }) => {
                const rows = unlock.allocations.filter((row) => row.group === id);
                const known = rows.length > 0 && rows.every(({ amount }) => amount !== null);
                const quantity = known ? rows.reduce((sum, { amount }) => sum + (amount ?? 0), 0)
                  : allocationComplete && rows.length === 0 ? 0 : null;
                return (
                  <tr key={id}>
                    <th scope="row">{title}{rows.length > 0 && <small>{rows.map(({ name }) => name).join("、")}</small>}</th>
                    <td>{quantity === null ? "—" : tokens.format(quantity)}</td>
                    <td>{price === null || quantity === null ? "—" : dollars.format(quantity * price)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className={styles.fundamentalsNote}>来源未披露本次分配明细。</p>}
      <p className={styles.fundamentalsNote}>金额按当前美元价格估算。分组按来源披露的用途，基金会、生态及金库单列在其他类别。
        {unlock.allocations.length > 0 && !allocationComplete && " 部分分配缺少可核实的数量。"}
      </p>
      <a className={styles.fundamentalsLink} href={unlock.sourceUrl} target="_blank" rel="noreferrer">{unlock.sourceName} 解锁来源</a>
    </>
  );
}

export default function CoinFundamentals({ symbol }: { symbol: string }) {
  const [data, setData] = useState<CoinOverview | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const params = new URLSearchParams({ symbol });
    async function load() {
      try {
        const response = await fetch(apiUrl(`/api/markets/fundamentals?${params}`), { signal: request.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Coin fundamentals unavailable.");
        const next: CoinOverview = await response.json();
        if (!request.signal.aborted) {
          setData(next);
          setError(false);
        }
      } catch {
        if (!request.signal.aborted) setError(true);
      } finally {
        if (!request.signal.aborted) timer = setTimeout(load, 60_000);
      }
    }
    void load();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [symbol]);

  const market = data?.market;
  const unlock = data?.unlock && data.unlock.time > Date.now() ? data.unlock : null;
  const status = data?.status === "not-applicable" ? "该资产没有适用的代币市值和解锁数据。"
    : data?.status === "unmapped" ? "暂无可核实的币种资料。" : null;
  return (
    <section className={`${styles.result} ${styles.fundamentals}`} aria-label="市值与代币解锁">
      <h3 className={styles.marketTitle}>市值与代币解锁</h3>
      {status ? <p className={styles.fundamentalsNote}>{status}</p> : (
        <div className={styles.fundamentalsGrid}>
          <div>
            <h4>市值</h4>
            <dl className={styles.metrics}>
              <div><dt>流通市值</dt><dd>{usd(market?.circulatingMarketCap ?? null)}</dd></div>
              <div><dt>总市值</dt><dd>{usd(market?.totalMarketCap ?? null)}</dd></div>
            </dl>
            {market && <p className={styles.fundamentalsNote}>
              总市值 = 当前价格 × 总供应量。
              {market.updatedAt !== null && <>截至 <time dateTime={new Date(market.updatedAt).toISOString()}>{time.format(market.updatedAt)}</time>。</>}
            </p>}
            {market && <a className={styles.fundamentalsLink} href={market.sourceUrl} target="_blank" rel="noreferrer">{market.sourceName} 市值来源</a>}
            {(error || data?.marketError) && <p className={styles.fundamentalsNote} role="status">市值同步失败，稍后重试。</p>}
            {data && !market && !data.marketError && <p className={styles.fundamentalsNote}>暂无市值数据。</p>}
          </div>
          <div>
            <h4>下一次解锁与分配</h4>
            {unlock ? <Allocation unlock={unlock} price={market?.price ?? null} />
              : <p className={styles.fundamentalsNote} role="status">
                {error || data?.unlockError ? "解锁资料同步失败，稍后重试。" : data ? "暂无已核实的未来解锁记录。" : "正在查询解锁资料…"}
              </p>}
          </div>
        </div>
      )}
    </section>
  );
}
