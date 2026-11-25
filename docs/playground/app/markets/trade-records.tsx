"use client";

import { Fragment, useId, useState } from "react";
import { isTradeActive, STANDARD_TAKER_FEE_RATE, tradeExecution, tradingModeLabels, type Trade, type TradeOrder, type TradingMode } from "@/lib/trading-types";
import { marketNumberFormatter } from "@/lib/market-number";
import { useRecordSelection } from "./use-record-selection";
import styles from "./markets.module.css";

const formatPrice = marketNumberFormatter({ maximumSignificantDigits: 10 });
const formatPnl = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 8, signDisplay: "exceptZero" });
const formatFee = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 8 });
const formatTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" });
const PAGE_SIZE = 10;
const COLUMN_COUNT = 8;
const statusFilters = { all: "全部状态", active: "进行中", closed: "已平仓", failed: "失败" } as const;
const accountFilters = { all: "全部账户", demo: "模拟盘", live: "实盘" } as const;
const statusLabels: Record<Trade["status"], string> = {
  opening: "开仓中", open: "持仓中", closing: "平仓中", closed: "已平仓", failed: "失败",
};
const orderLabels: Record<TradeOrder["kind"], string> = {
  entry: "开仓", "stop-loss": "止损", "take-profit": "止盈", exit: "平仓",
};
const orderStatusLabels: Record<TradeOrder["status"], string> = {
  placed: "已挂单", filled: "已成交", canceled: "已撤销", triggered: "已触发", failed: "失败",
};

function canRemoveTrade(trade: Trade) {
  return trade.status === "closed" || trade.status === "failed";
}

function TradeDetails({ trade, execution }: { trade: Trade; execution: ReturnType<typeof tradeExecution> }) {
  const { entryFee, exitFee } = execution;
  return (
    <>
      <dl className={styles.tradeDetailGrid}>
        <div><dt>策略</dt><dd>{trade.strategy.name}</dd></div>
        <div><dt>数量 / 金额 (USDT)</dt><dd>{trade.amount} / {formatPrice(trade.notional)}</dd></div>
        <div><dt>止损 / 止盈触发价</dt><dd>{formatPrice(trade.stopLoss ?? undefined)} / {formatPrice(trade.takeProfit ?? undefined)}</dd></div>
        <div><dt>开仓手续费 (USDT)</dt><dd>{entryFee === null ? "—" : formatFee.format(entryFee)}</dd></div>
        <div><dt>平仓手续费 (USDT)</dt><dd>{exitFee === null ? "—" : formatFee.format(exitFee)}</dd></div>
        {isTradeActive(trade) && <div><dt>到期时间</dt><dd>{formatTime.format(trade.deadline)}</dd></div>}
        {trade.closedAt != null && <div><dt>平仓时间</dt><dd>{formatTime.format(trade.closedAt)}</dd></div>}
        {trade.exitReason && <div><dt>平仓原因</dt><dd>{trade.exitReason}</dd></div>}
        {trade.note && <div><dt>备注</dt><dd>{trade.note}</dd></div>}
        {trade.error && <div><dt>错误</dt><dd>{trade.error}</dd></div>}
      </dl>
      {trade.orders.length > 0 && (
        <div className={styles.tradeOrders}>
          <strong>订单明细</strong>
          <ul>
            {trade.orders.map((order, index) => <li key={index}>
              {orderLabels[order.kind]} {order.side === "buy" ? "买" : "卖"}
              {order.triggerPrice !== null ? ` 触发价 ${formatPrice(order.triggerPrice)}` : ""}
              {order.execution ? ` 成交均价 ${formatPrice(order.execution.quote / order.execution.filled)}` : ""} · {orderStatusLabels[order.status]}
              {order.exchangeId && <> · 订单号 {order.exchangeId}</>}
              {order.error && <> · {order.error}</>}
            </li>)}
          </ul>
        </div>
      )}
    </>
  );
}

export default function TradeRecords({ trades, activeMode, canDelete, onDelete, onClose }: {
  trades: readonly Trade[];
  activeMode: TradingMode;
  canDelete: boolean;
  onDelete: (ids: readonly string[]) => Promise<void>;
  onClose: (tradeId: string) => Promise<unknown>;
}) {
  const [closing, setClosing] = useState<string | null>(null);
  const [closeError, setCloseError] = useState("");
  const [symbol, setSymbol] = useState("");
  const [status, setStatus] = useState<keyof typeof statusFilters>("all");
  const [account, setAccount] = useState<keyof typeof accountFilters>("all");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const detailId = useId();
  const active = trades.filter(isTradeActive).length;
  const search = symbol.trim().toUpperCase();
  const filtered = trades.filter((trade) =>
    trade.symbol.toUpperCase().includes(search) &&
    (status === "all" || (status === "active" ? isTradeActive(trade) : trade.status === status)) &&
    (account === "all" || trade.mode === account),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);
  const removable = filtered.filter(canRemoveTrade);
  const canSelect = canDelete && closing === null;
  const { selected, count, deleting, error, deletedCount, allSelected, partlySelected, select, selectAll, deleteSelected } =
    useRecordSelection(removable, (trade) => trade.id, {
      label: "下单记录", canDelete: canSelect,
      onDelete: (rows) => onDelete(rows.map(({ id }) => id)),
      confirmation: " 此操作仅删除本地下单记录。",
    });

  function resetView() {
    setPage(1);
    setExpanded(null);
    selectAll(false);
  }

  async function close(trade: Trade) {
    if (!window.confirm(`确认按市价平掉 ${trade.symbol} ${trade.side === "long" ? "多仓" : "空仓"}（${tradingModeLabels[trade.mode]}）？`)) return;
    setClosing(trade.id);
    setCloseError("");
    try {
      await onClose(trade.id);
    } catch (caught) {
      setCloseError(caught instanceof Error ? caught.message : "平仓失败。");
    } finally {
      setClosing(null);
    }
  }

  return (
    <details className={styles.monitorFeature} open={active > 0}>
      <summary className={styles.monitorSummary}>
        <h3>下单记录 <small>{trades.length} 条{active ? ` · ${active} 笔进行中` : ""}</small></h3>
      </summary>
      <div className={styles.monitorBody}>
        {trades.length > 0 && (
          <div className={styles.tradeToolbar}>
            <div className={styles.tradeFilters}>
              <input aria-label="搜索交易对" placeholder="搜索交易对" type="search" value={symbol} disabled={deleting}
                onChange={(event) => { setSymbol(event.currentTarget.value); resetView(); }} />
              <select aria-label="筛选下单状态" value={status} disabled={deleting}
                onChange={(event) => { setStatus(event.currentTarget.value as typeof status); resetView(); }}>
                {Object.entries(statusFilters).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select aria-label="筛选账户" value={account} disabled={deleting}
                onChange={(event) => { setAccount(event.currentTarget.value as typeof account); resetView(); }}>
                {Object.entries(accountFilters).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div className={styles.alertActions}>
              <span>已选 {count} 条</span>
              <button type="button" disabled={!canSelect || deleting || count === 0} onClick={() => void deleteSelected()}>
                {deleting ? "正在删除…" : "删除选中记录"}
              </button>
            </div>
          </div>
        )}
        {closeError && <p role="alert">{closeError}</p>}
        {error && <p role="alert">{error}</p>}
        {deletedCount > 0 && <p role="status">已删除 {deletedCount} 条下单记录。</p>}
        <div className={styles.tableScroll}>
          <table className={`${styles.alertTable} ${styles.tradeTable}`}>
            <thead><tr>
              <th scope="col">
                <label className={styles.alertSelectAll}>
                  <input type="checkbox" checked={allSelected} disabled={!canSelect || deleting || removable.length === 0}
                    aria-label="全选筛选结果中所有已结束的下单记录"
                    title="全选筛选结果中的已结束记录，包含其他页"
                    ref={(input) => { if (input) input.indeterminate = partlySelected; }}
                    onChange={(event) => selectAll(event.currentTarget.checked)} />
                  全选{pageCount > 1 ? "（跨页）" : ""}
                </label>
              </th>
              <th scope="col">交易对</th>
              <th scope="col">状态</th>
              <th scope="col" className={styles.tradeNumeric}>净盈亏 (USDT)</th>
              <th scope="col">实际成交均价</th>
              <th scope="col" className={styles.tradeNumeric}>手续费 (USDT)</th>
              <th scope="col">开仓时间</th>
              <th scope="col">操作</th>
            </tr></thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={COLUMN_COUNT} className={styles.emptyTableCell}>
                  <span role="status">{trades.length === 0 ? "暂无下单记录。" : "没有符合筛选条件的下单记录。"}</span>
                </td></tr>
              )}
              {visible.map((trade) => {
                const execution = tradeExecution(trade);
                const { entryPrice, exitPrice, entryFee, exitFee, netPnl } = execution;
                const fee = entryFee === null && exitFee === null ? null : (entryFee ?? 0) + (exitFee ?? 0);
                const canRemove = canRemoveTrade(trade);
                const isExpanded = expanded === trade.id;
                return <Fragment key={trade.id}>
                  <tr className={styles.tradeRow}>
                    <td>
                      <input type="checkbox" checked={canRemove && selected.has(trade.id)}
                        disabled={!canSelect || deleting || !canRemove}
                        aria-label={`选择 ${trade.symbol} ${formatTime.format(trade.openedAt)} 的下单记录`}
                        onChange={(event) => select(trade.id, event.currentTarget.checked)} />
                    </td>
                    <th scope="row">
                      <strong>{trade.symbol}</strong>
                      <div className={styles.tradeMeta}>
                        <span>{trade.side === "long" ? "做多" : "做空"} · {trade.leverage}x</span>
                        <span className={trade.mode === "live" ? styles.tradingLive : styles.tradingDemo}>{tradingModeLabels[trade.mode]}</span>
                      </div>
                    </th>
                    <td><span className={styles.tradeStatus} data-status={isTradeActive(trade) ? "active" : trade.status}>
                      {statusLabels[trade.status]}</span></td>
                    <td className={styles.tradeNumeric}>
                      <strong className={netPnl === null || netPnl === 0 ? undefined : netPnl > 0 ? styles.buy : styles.sell}>
                        {netPnl === null ? "—" : formatPnl.format(netPnl)}
                      </strong>
                    </td>
                    <td className={styles.tradePrices}>
                      <div><small>开仓</small>{formatPrice(entryPrice ?? undefined)}</div>
                      <div><small>平仓</small>{formatPrice(exitPrice ?? undefined)}</div>
                    </td>
                    <td className={styles.tradeNumeric}>{fee === null ? "—" : formatFee.format(fee)}</td>
                    <td><time dateTime={new Date(trade.openedAt).toISOString()}>{formatTime.format(trade.openedAt)}</time></td>
                    <td>
                      <div className={styles.tradeActions}>
                        <button type="button" aria-expanded={isExpanded} aria-controls={isExpanded ? detailId : undefined}
                          onClick={() => setExpanded(isExpanded ? null : trade.id)}>
                          {isExpanded ? "收起" : "详情"}
                        </button>
                        {isTradeActive(trade) && <button type="button" className={styles.tradingClose}
                          disabled={deleting || closing !== null || activeMode !== trade.mode} onClick={() => void close(trade)}>
                          {closing === trade.id ? "平仓中…" : "市价平仓"}
                        </button>}
                      </div>
                    </td>
                  </tr>
                  {isExpanded && <tr><td id={detailId} colSpan={COLUMN_COUNT} className={styles.tradeDetailCell}>
                    <TradeDetails trade={trade} execution={execution} />
                  </td></tr>}
                </Fragment>;
              })}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className={styles.tradePagination}>
            <span role="status">第 {start + 1}–{start + visible.length} 条，共 {filtered.length} 条</span>
            {pageCount > 1 && <div>
              <button type="button" disabled={currentPage === 1} onClick={() => { setPage(currentPage - 1); setExpanded(null); }}>上一页</button>
              <button type="button" disabled={currentPage === pageCount} onClick={() => { setPage(currentPage + 1); setExpanded(null); }}>下一页</button>
            </div>}
          </div>
        )}
        <p className={styles.tradeFeeNote}>手续费汇总已核实的成交，按普通用户 Taker 费率 {(STANDARD_TAKER_FEE_RATE * 100).toFixed(2)}% 估算。
          净盈亏扣除开仓和平仓手续费，未计资金费。</p>
      </div>
    </details>
  );
}
