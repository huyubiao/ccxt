import { useEffect, useRef, useState } from "react";
import { SPIKE_RECORD_LIMIT, spikeStatusLabels, type AlertHistoryRow } from "@/lib/alert-history";
import { apiUrl } from "@/lib/basePath";
import { formatAlertTurnover, formatMarketAmount, formatMarketPriceRange, marketNumberFormatter } from "@/lib/market-number";
import { alertDayStart, spikeKey, type SpikeIdentity } from "@/lib/price-alerts";
import { useRecordSelection } from "./use-record-selection";
import styles from "./markets.module.css";

const formatTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" });
const formatPrice = marketNumberFormatter({ maximumSignificantDigits: 12 });
const formatChange = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" });
const formatThreshold = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4, signDisplay: "exceptZero" });

function dayKey({ symbol, time }: AlertHistoryRow) {
  return JSON.stringify([alertDayStart(time), symbol]);
}

export default function AlertRecords({ records, canDelete, onDelete }: {
  records: readonly AlertHistoryRow[];
  canDelete: boolean;
  onDelete: (records: readonly SpikeIdentity[]) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { selected, count, deleting, error, deletedCount, allSelected, partlySelected, select, selectAll, deleteSelected } =
    useRecordSelection(records, spikeKey, {
      label: "告警记录", canDelete, onDelete: (rows) => onDelete(rows.map(({ symbol, time, threshold }) => ({ symbol, time, threshold }))),
    });
  const cache = useRef(new Map<string, number>());
  const [opens, setOpens] = useState<ReadonlyMap<string, number>>(new Map());
  const keys = JSON.stringify([...new Set(records.map(dayKey))].sort().reverse());

  useEffect(() => {
    if (!expanded) return;
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
  }, [expanded, keys]);

  return (
    <details className={styles.turnover} onToggle={(event) => setExpanded(event.currentTarget.open)}>
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
            <th scope="col">窗口涨跌幅/阈值</th><th scope="col">窗口 (秒)</th>
            <th scope="col">成交额 (USDT)</th><th scope="col">核验结果</th>
          </tr></thead>
          <tbody>
            {records.length === 0 && (
              <tr><td colSpan={10} className={styles.emptyTableCell}><span role="status">暂无告警记录。</span></td></tr>
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
                <td>{formatMarketPriceRange(row.previous, row.price, formatPrice, " / ")}</td>
                <td className={dailyChange === null || dailyChange === 0 ? undefined : dailyChange < 0 ? styles.sell : styles.buy}>
                  {dailyChange === null ? "—" : `${formatChange.format(dailyChange)}%`}
                </td>
                <td><span className={row.change < 0 ? styles.sell : styles.buy}>{formatChange.format(row.change)}%</span>
                  {" / "}{formatThreshold.format(row.threshold)}%</td>
                <td>{row.seconds}</td>
                <td>{formatAlertTurnover(row.volume, row.legacyMultiple) ?? formatMarketAmount(row.volume?.turnover)}</td>
                <td title={row.requiredMultiple === null ? undefined : `成交额门槛 ${row.requiredMultiple} 倍`}>
                  {spikeStatusLabels[row.status]}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
