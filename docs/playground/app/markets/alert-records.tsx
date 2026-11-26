import { useEffect, useRef, useState } from "react";
import { SPIKE_RECORD_LIMIT, spikeStatusLabels, type AlertHistoryRow } from "@/lib/alert-history";
import { apiUrl } from "@/lib/basePath";
import type { BreakoutObservation, ContinuationResult } from "@/lib/background-monitor-types";
import { formatAlertTurnover, formatMarketAmount, formatMarketPriceRange, marketNumberFormatter } from "@/lib/market-number";
import { alertDayStart, spikeKey, type SpikeIdentity } from "@/lib/price-alerts";
import { useRecordSelection } from "./use-record-selection";
import { useRememberedDetails } from "./use-remembered-details";
import styles from "./markets.module.css";

const formatTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" });
const formatPrice = marketNumberFormatter({ maximumSignificantDigits: 12 });
const formatChange = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" });
const formatThreshold = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4, signDisplay: "exceptZero" });
const formatScorePercent = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const continuationLabels: Record<ContinuationResult["status"], string> = {
  pending: "待评分", submitting: "正在下单", ordered: "已开仓", "below-score": "未达下单分数",
  disabled: "已达标，自动下单关闭", "no-account": "已达标，未连接交易账号", unavailable: "历史行情不足或获取失败",
  "observation-unavailable": "突破观察不可用，跳过下单", "breakout-lost": "突破失守，跳过下单",
  "queue-skipped": "评分队列已满", interrupted: "评估已中断或过期", unknown: "下单结果待核对", failed: "未完成下单",
};
const sideLabels = { long: "多头", short: "空头" };
const observationLabels = {
  pending: "等待观察", "queue-skipped": "观察队列已满", "no-trades": "观察窗口内无成交",
  unavailable: "成交数据不可用", interrupted: "观察已中断",
};
const breakoutLabels = { held: "站稳", recovered: "回吐后收复", lost: "失守" };

function BreakoutDetails({ observation }: { observation: BreakoutObservation }) {
  if (observation.status !== "ready") return <div>突破后走势 · {observationLabels[observation.status]}</div>;
  const { windowSeconds, buyUsdt, sellUsdt, netPercent, position, targetPrice, lastPrice, lastTradeTime } = observation;
  const buyShare = (100 + netPercent) / 2;
  return <>
    <div title={`主动买入 ${formatMarketAmount(buyUsdt)} USDT，主动卖出 ${formatMarketAmount(sellUsdt)} USDT`}>
      触发后 {windowSeconds} 秒主动成交 · 买入 {formatScorePercent.format(buyShare)}% · 卖出 {formatScorePercent.format((100 - netPercent) / 2)}%
    </div>
    <div title={`窗口内最后一笔成交时间 ${formatTime.format(lastTradeTime)}`}>
      突破后走势 · {breakoutLabels[position]}（门槛价 {formatPrice(targetPrice)}，最后成交价 {formatPrice(lastPrice)}）
    </div>
  </>;
}

function ContinuationCell({ result, observation }: { result?: ContinuationResult; observation?: BreakoutObservation }) {
  const label = result ? continuationLabels[result.status] : "走势观察";
  const { score, side, target, error } = result ?? {};
  if (!score && !observation) return result ? label : "—";
  return <details className={styles.alertContinuation}>
    <summary>{score && `${score.total} 分 · ${side === "long" ? "做多" : "做空"} · `}{label}</summary>
    {observation && <BreakoutDetails observation={observation} />}
    {score && ("breakoutPoints" in score ? <>
      <div>突破站稳 {score.breakoutPoints}/35</div>
      <div>同向主动成交 {score.flowPoints}/35</div>
      <div>成交额 {score.turnoverPoints}/20</div>
      <div>历史振幅 {score.pricePoints}/10{score.rangePercent === null ? "（历史数据不足）" : `（${formatScorePercent.format(score.rangePercent)}%）`}</div>
      <div><a href="#coin-research">在币种深度调研查看强平估算</a></div>
    </> : <>
      <div>涨跌幅 {score.pricePoints}/60{score.rangePercent !== null && `（振幅 ${formatScorePercent.format(score.rangePercent)}%）`}</div>
      <div>成交额 {score.turnoverPoints}/30</div>
      <div>强平 {score.liquidationPoints}/10{score.nearSharePercent === null ? "（缺少估算）" :
        `（${score.dominantSide ? `${sideLabels[score.dominantSide]}占优` : "多空持平"}，同向近价占比 ${formatScorePercent.format(score.nearSharePercent)}%）`}</div>
    </>)}
    {score && <div>下单门槛 {target} 分</div>}
    {error && <div>{error}</div>}
  </details>;
}

function dayKey({ symbol, time }: AlertHistoryRow) {
  return JSON.stringify([alertDayStart(time), symbol]);
}

export default function AlertRecords({ records, canDelete, onDelete }: {
  records: readonly AlertHistoryRow[];
  canDelete: boolean;
  onDelete: (records: readonly SpikeIdentity[]) => Promise<void>;
}) {
  const details = useRememberedDetails("alert-records");
  const { selected, count, deleting, error, deletedCount, allSelected, partlySelected, select, selectAll, deleteSelected } =
    useRecordSelection(records, spikeKey, {
      label: "告警记录", canDelete, onDelete: (rows) => onDelete(rows.map(({ symbol, time, threshold }) => ({ symbol, time, threshold }))),
    });
  const cache = useRef(new Map<string, number>());
  const [opens, setOpens] = useState<ReadonlyMap<string, number>>(new Map());
  const keys = JSON.stringify([...new Set(records.map(dayKey))].sort().reverse());

  useEffect(() => {
    if (!details.open) return;
    const controller = new AbortController();
    const current = cache.current;
    const targets = JSON.parse(keys) as string[];
    const pending = targets.filter((key) => !current.has(key));
    if (current.size + pending.length > 2 * SPIKE_RECORD_LIMIT) {
      const retained = new Set(targets);
      for (const key of current.keys()) {
        if (!retained.has(key)) current.delete(key);
      }
    }
    async function load() {
      while (!controller.signal.aborted && pending.length) {
        const key = pending.shift()!;
        const [day, symbol] = JSON.parse(key) as [number, string];
        const params = new URLSearchParams({ symbol, time: String(day), view: "day-open" });
        try {
          const response = await fetch(apiUrl(`/api/markets/alert-context?${params}`), {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          });
          if (!response.ok) continue;
          const { open } = await response.json();
          if (!controller.signal.aborted && typeof open === "number" && Number.isFinite(open) && open > 0) {
            current.set(key, open);
            setOpens(new Map(current));
          }
        } catch { /* Leave the daily change unavailable if the request fails. */ }
      }
    }
    void load();
    void load();
    return () => controller.abort();
  }, [details.open, keys]);

  return (
    <details className={styles.turnover} {...details}>
      <summary className={styles.monitorSectionSummary}>
        <h4>告警记录 <span>最近 {SPIKE_RECORD_LIMIT} 条</span></h4>
      </summary>
      {records.length > 0 && (
        <div className={styles.alertActions}>
          <span>已选 {count} 条</span>
          <button type="button" disabled={!canDelete || deleting || !count} onClick={() => void deleteSelected()}>
            {deleting ? "正在删除…" : "删除选中记录"}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {deletedCount > 0 && <p role="status">已删除 {deletedCount} 条告警记录。</p>}
      <div className={`${styles.tableScroll} ${styles.alertScroll}`}>
        <table className={styles.alertTable}>
          <thead><tr>
            <th scope="col">
              <label className={styles.alertSelectAll}>
                <input type="checkbox" checked={allSelected} disabled={deleting || records.length === 0}
                  aria-label="全选当前显示的告警记录"
                  ref={(input) => { if (input) input.indeterminate = partlySelected; }}
                  onChange={(event) => selectAll(event.currentTarget.checked)} />
                全选
              </label>
            </th>
            <th scope="col">交易对</th><th scope="col">告警级别</th><th scope="col">触发时间</th>
            <th scope="col">参考价/触发价 (USDT)</th>
            <th scope="col" title="按北京时间当日开盘价到触发价计算">当日涨跌幅度</th>
            <th scope="col">涨跌幅 / 触发阈值</th><th scope="col">监控窗口</th>
            <th scope="col">成交额 (USDT)</th><th scope="col">核验结果</th><th scope="col">延续评分与下单</th>
          </tr></thead>
          <tbody>
            {records.length === 0 && (
              <tr><td colSpan={11} className={styles.emptyTableCell}><span role="status">暂无告警记录。</span></td></tr>
            )}
            {records.map((row) => {
              const key = spikeKey(row);
              const triggerTime = formatTime.format(row.time);
              const open = opens.get(dayKey(row));
              const change = open === undefined ? NaN : (row.price - open) / open * 100;
              const dailyChange = Number.isFinite(change) ? change : null;
              return <tr key={key}>
                <td>
                  <input type="checkbox" checked={selected.has(key)} disabled={deleting}
                    aria-label={`选择 ${row.symbol} ${triggerTime} ${row.threshold > 0 ? "上涨" : "下跌"}告警`}
                    onChange={(event) => select(key, event.target.checked)} />
                </td>
                <th scope="row">{row.symbol}</th>
                <td>{row.level} 级</td>
                <td><time dateTime={new Date(row.time).toISOString()}>{triggerTime}</time></td>
                <td>
                  {formatMarketPriceRange(row.previous, row.price, formatPrice, " / ")}
                  {row.originalReference !== undefined && row.originalReference !== row.previous &&
                    <div>原始参考价 {formatPrice(row.originalReference)}</div>}
                </td>
                <td className={dailyChange === null || dailyChange === 0 ? undefined : dailyChange < 0 ? styles.sell : styles.buy}>
                  {dailyChange === null ? "—" : `${formatChange.format(dailyChange)}%`}
                </td>
                <td><span className={row.change < 0 ? styles.sell : styles.buy}>{formatChange.format(row.change)}%</span>
                  {" / "}{formatThreshold.format(row.threshold)}%</td>
                <td>{row.observationMinutes !== undefined ? `${row.observationMinutes} 分钟观察` : `${row.seconds} 秒`}</td>
                <td>{formatAlertTurnover(row.volume, row.legacyMultiple) ?? formatMarketAmount(row.volume?.turnover)}</td>
                <td title={row.requiredMultiple === null ? undefined : `成交额门槛 ${row.requiredMultiple} 倍`}>
                  {spikeStatusLabels[row.status]}
                </td>
                <td><ContinuationCell result={row.continuation} observation={row.breakoutObservation} /></td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
