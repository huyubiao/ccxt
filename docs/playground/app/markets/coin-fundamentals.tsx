"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import type { CoinOverview, CoinUnlock, Tokenomics, UnlockAllocation } from "@/lib/coin-overview";
import styles from "./markets.module.css";
import CoinHolders from "./coin-holders";

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
          <dd>{unlock.timeKind === "interval-estimate" && unlock.periodStart != null
            ? `${time.format(unlock.periodStart)} 至 ${time.format(unlock.time)}（区间估算）`
            : <time dateTime={new Date(unlock.time).toISOString()}>{time.format(unlock.time)}</time>}</dd></div>
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

function SupplySchedule({ data, price }: { data: Tokenomics; price: number | null }) {
  if (data.kind === "staking" && data.staking) {
    const staking = data.staking;
    return <>
      <dl className={styles.metrics}>
        <div><dt>发行机制</dt><dd>权益证明（PoS）持续发行</dd></div>
        <div><dt>新增发行分配给</dt><dd>{staking.recipients}</dd></div>
        <div><dt>每日新增发行</dt><dd>{staking.dailyIssuance === null ? "随网络状态变化，暂未取得日统计" : `${tokens.format(staking.dailyIssuance)} ${data.symbol}`}</dd></div>
        <div><dt>下一次减半</dt><dd>无固定减半计划</dd></div>
        <div><dt>手续费销毁</dt><dd>{staking.hasFeeBurn ? "按协议销毁基础费用" : "未启用"}</dd></div>
      </dl>
      <p className={styles.fundamentalsNote}>新增发行随质押总量及验证者参与情况变化。净供应变化 = 新增发行 − 销毁量。</p>
      <a className={styles.fundamentalsLink} href={data.sourceUrl} target="_blank" rel="noreferrer">{data.sourceName} 发行与销毁说明</a>
    </>;
  }
  if (data.kind === "mining") {
    const mining = data.mining;
    return <>
      <p className={styles.fundamentalsNote}>通过区块奖励持续发行，分配给矿工。</p>
      {mining ? <>
        <dl className={styles.metrics}>
          <div><dt>每区块新发行（快照）</dt><dd>{tokens.format(mining.blockReward)} {data.symbol}</dd></div>
          <div><dt>每日新增（估算）</dt><dd>{tokens.format(mining.estimatedDailyIssuance)} {data.symbol}</dd></div>
          <div><dt>下一次减半（预计）</dt><dd><time dateTime={new Date(mining.estimatedHalvingTime).toISOString()}>{time.format(mining.estimatedHalvingTime)}</time></dd></div>
          <div><dt>减半目标高度</dt><dd>{mining.nextHalvingHeight.toLocaleString()}</dd></div>
          <div><dt>减半后每区块新发行</dt><dd>{tokens.format(mining.nextBlockReward)} {data.symbol}</dd></div>
          <div><dt>减半后每日新增（估算）</dt><dd>{tokens.format(mining.nextEstimatedDailyIssuance)} {data.symbol}</dd></div>
        </dl>
        <p className={styles.fundamentalsNote}>按目标出块间隔估算，实际每日发行量随出块数量变化。减半由区块高度决定。
          估算基于区块 {mining.blockHeight.toLocaleString()}，快照日期 {time.format(data.updatedAt)}。
        </p>
        <a className={styles.fundamentalsLink} href={mining.heightSourceUrl} target="_blank" rel="noreferrer">区块高度来源</a>{" · "}
      </> : <p className={styles.fundamentalsNote}>尚未取得区块高度快照，暂无法核实当前奖励和减半估算。</p>}
      <a className={styles.fundamentalsLink} href={data.sourceUrl} target="_blank" rel="noreferrer">{data.sourceName} 发行规则</a>
    </>;
  }
  return <>
    <dl className={styles.metrics}>
      <div><dt>待解锁数量</dt><dd>{data.lockedAmount === null ? "未披露" : `${tokens.format(data.lockedAmount)} ${data.symbol}`}</dd></div>
    </dl>
    <div className={styles.tableScroll}>
      <table className={styles.unlockTable}>
        <thead><tr><th scope="col">未来解锁时间</th><th scope="col">数量 ({data.symbol})</th><th scope="col">占总量</th></tr></thead>
        <tbody>{[0, 1, 2].map((index) => {
          const event = data.events[index];
          return <tr key={index}>
            <th scope="row">{event ? event.timeKind === "interval-estimate" && event.periodStart != null
              ? <>{time.format(event.periodStart)} 至<small>{time.format(event.time)}（区间估算）</small></>
              : <time dateTime={new Date(event.time).toISOString()}>{time.format(event.time)}</time> : `第 ${index + 1} 次待补充`}</th>
            <td>{event ? tokens.format(event.amount) : "—"}</td>
            <td>{event?.supplyPercentage == null ? "—" : `${event.supplyPercentage.toFixed(4)}%`}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {data.percentageSupply !== null && <p className={styles.fundamentalsNote}>
      占比按{data.percentageBasis === "maxSupply" ? "供应上限" : "快照总供应量"} {tokens.format(data.percentageSupply)} {data.symbol} 计算。
    </p>}
    {data.events.map((event) => <details key={event.time}>
      <summary>{time.format(event.time)} {event.timeKind === "interval-estimate" ? "区间释放分配估算" : "解锁分配明细"}</summary>
      <Allocation unlock={event} price={price} />
    </details>)}
    {data.kind === "unknown" && <p className={styles.fundamentalsNote}>发行或锁仓计划尚未核实。</p>}
    {data.events.length < 3 && <p className={styles.fundamentalsNote}>目前来源仅提供 {data.events.length} 次可核实的未来事件，缺少的期次待补充。</p>}
    {data.events.some((event) => event.timeKind === "interval-estimate") && <p className={styles.fundamentalsNote}>
      区间估算来自释放曲线相邻采样点的增量，实际解锁可能发生在区间内的不同时间。
    </p>}
  </>;
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
  const snapshotAt = data?.tokenomics?.updatedAt ?? data?.unlockSnapshotAt;
  return (
    <details className={`${styles.result} ${styles.fundamentals}`} open>
      <summary className={styles.researchSummary}><h3 className={styles.marketTitle}>代币详情</h3></summary>
      {data?.status === "not-applicable" ? <p className={styles.fundamentalsNote}>该资产没有适用的代币市值和解锁数据。</p> : (
        <div className={styles.fundamentalsGrid}>
          <div>
            <h4>市值</h4>
            <dl className={styles.metrics}>
              <div><dt>流通市值</dt><dd>{usd(market?.circulatingMarketCap ?? null)}</dd></div>
              <div><dt>总市值（按供应上限）</dt><dd>{(market?.supplyLimit ?? data?.tokenomics?.supplyLimit) === "unlimited"
                ? "无上限" : usd(market?.totalMarketCap ?? null)}</dd></div>
            </dl>
            {market && <p className={styles.fundamentalsNote}>
              总市值按当前价格 × 供应上限估算，供应上限未核实时显示 —。
              {market.updatedAt !== null && <>截至 <time dateTime={new Date(market.updatedAt).toISOString()}>{time.format(market.updatedAt)}</time>。</>}
            </p>}
            {market && <a className={styles.fundamentalsLink} href={market.sourceUrl} target="_blank" rel="noreferrer">{market.sourceName} 市值来源</a>}
            {(error || data?.marketError) && <p className={styles.fundamentalsNote} role="status">市值同步失败，稍后重试。</p>}
            {data && !market && !data.marketError && <p className={styles.fundamentalsNote}>
              {data.status === "unmapped" ? "暂无可核实的币种市值资料。" : "暂无市值数据。"}
            </p>}
          </div>
          <div>
            <h4>解锁与分配</h4>
            {data?.tokenomics ? <SupplySchedule data={data.tokenomics} price={market?.price ?? null} />
              : <p className={styles.fundamentalsNote} role="status">
                {data ? "本地快照没有该币种的未来解锁记录，或记录已到期。"
                  : error ? "暂时无法读取解锁快照。" : "正在读取解锁快照…"}
              </p>}
            {snapshotAt != null && <p className={styles.fundamentalsNote}>{data?.tokenomics?.kind === "staking" ? "发行规则核对于" : "本地快照更新于"}{" "}
              <time dateTime={new Date(snapshotAt).toISOString()}>{time.format(snapshotAt)}</time>。
            </p>}
          </div>
          <CoinHolders key={symbol} symbol={symbol} />
        </div>
      )}
    </details>
  );
}
