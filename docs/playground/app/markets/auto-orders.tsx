import {
  AUTO_ORDER_SYMBOL_LIMIT, AUTO_ORDER_WATCH_MS, autoOrderRequestKey, autoOrderWatchKey, isAutoOrderActive,
  type AutoOrderRequest, type AutoOrderWatch, type AutoOrderWatchIdentity,
} from "@/lib/auto-order";
import { formatMarketPriceRange, fullMarketNumber, marketNumberFormatter } from "@/lib/market-number";
import { useRecordSelection } from "./use-record-selection";
import styles from "./markets.module.css";

const formatPrice = marketNumberFormatter({ maximumSignificantDigits: 12 });
const formatTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" });
const statusLabels: Record<AutoOrderWatch["status"], string> = {
  starting: "等待行情", watching: "监控中", finished: "无活动，监控结束", stopped: "已停止", failed: "启动或监控失败",
};

export default function AutoOrders({ records, canDelete, onDelete }: {
  records: readonly AutoOrderWatch[];
  canDelete: boolean;
  onDelete: (records: readonly AutoOrderWatchIdentity[]) => Promise<void>;
}) {
  const active = records.filter(isAutoOrderActive).length;
  const { selected, count, deleting, error, deletedCount, allSelected, partlySelected, select, selectAll, deleteSelected } =
    useRecordSelection(records, autoOrderWatchKey, {
      label: "自动下单任务记录", canDelete, confirmation: "运行中的任务会继续监控。",
      onDelete: (rows) => onDelete(rows.map(({ strategy, symbol, time }) => ({ strategy: { id: strategy.id }, symbol, time }))),
    });
  return (
    <details className={`${styles.monitorFeature} ${styles.autoOrderTasks}`}>
      <summary className={styles.monitorSummary}>
        <h3>自动下单任务</h3>
        <small>{active ? `${active} 条记录监控中` : "暂无监控中的记录"}</small>
      </summary>
      <div className={`${styles.monitorBody} ${styles.turnover}`}>
        <p>空仓且连续 {AUTO_ORDER_WATCH_MS / 60_000} 分钟没有有效信号时结束。</p>
        {records.length > 0 && <div className={styles.alertActions}>
          <span>已选 {count} 条</span>
          <button type="button" disabled={!canDelete || deleting || !count} onClick={() => void deleteSelected()}>
            {deleting ? "正在删除…" : "删除选中记录"}
          </button>
        </div>}
        {error && <p role="alert">{error}</p>}
        {deletedCount > 0 && <p role="status">已删除 {deletedCount} 条自动下单任务记录。</p>}
        {records.length > 0 && <div className={`${styles.tableScroll} ${styles.alertScroll}`}>
          <table className={styles.alertTable}>
            <thead><tr>
              <th scope="col">
                <label className={styles.alertSelectAll}>
                  <input type="checkbox" checked={allSelected} disabled={deleting}
                    aria-label="全选当前显示的自动下单任务记录"
                    ref={(input) => { if (input) input.indeterminate = partlySelected; }}
                    onChange={(event) => selectAll(event.currentTarget.checked)} />
                  全选
                </label>
              </th>
              <th scope="col">交易对</th><th scope="col">策略来源</th><th scope="col">触发时间</th>
              <th scope="col">最新价 (USDT)</th><th scope="col">监控区间 (USDT)</th>
              <th scope="col">监控状态</th>
            </tr></thead>
            <tbody>
              {records.map((row) => {
                const { symbol, strategy, time, status, quote, failure } = row;
                const key = autoOrderWatchKey(row);
                return <tr key={key}>
                  <td>
                    <input type="checkbox" checked={selected.has(key)} disabled={deleting}
                      aria-label={`选择 ${strategy.name} 的 ${symbol} 自动下单任务记录`}
                      onChange={(event) => select(key, event.currentTarget.checked)} />
                  </td>
                  <th scope="row">{symbol}</th>
                  <td>{strategy.name}</td>
                  <td><time dateTime={new Date(time).toISOString()}>{formatTime.format(time)}</time></td>
                  <td title={quote ? formatTime.format(quote.time) : undefined}>{formatPrice(quote?.price)}</td>
                  <td>{quote ? formatMarketPriceRange(quote.low, quote.high, formatPrice) : "—"}</td>
                  <td>{failure === "capacity" ? `失败：已达 ${AUTO_ORDER_SYMBOL_LIMIT} 个交易对上限` : statusLabels[status]}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>}
      </div>
    </details>
  );
}

export function StrategyOrderRequests({ strategyId, requests }: { strategyId: string; requests: readonly AutoOrderRequest[] }) {
  const strategyRequests = requests.filter((request) => request.strategyId === strategyId);
  return (
    <details className={styles.turnover}>
      <summary className={styles.monitorSectionSummary}>
        <h4>下单请求 <span>{strategyRequests.length} 条</span></h4>
      </summary>
      {strategyRequests.length === 0 ? <p role="status">暂无下单请求。</p> : (
        <div className={`${styles.tableScroll} ${styles.alertScroll}`}>
          <table className={styles.alertTable}>
            <thead><tr>
              <th scope="col">交易对</th><th scope="col">请求编号</th><th scope="col">方向</th>
              <th scope="col">数量</th><th scope="col">请求时间</th>
            </tr></thead>
            <tbody>
              {strategyRequests.map((request) => <tr key={autoOrderRequestKey(request)}>
                <th scope="row">{request.symbol}</th>
                <td>{request.id}</td>
                <td>{request.side === "buy" ? "买入" : "卖出"}</td>
                <td>{fullMarketNumber.format(request.amount)}</td>
                <td><time dateTime={new Date(request.time).toISOString()}>{formatTime.format(request.time)}</time></td>
              </tr>)}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
