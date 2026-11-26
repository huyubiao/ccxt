"use client";

import { Fragment, useId, useState, type FormEvent } from "react";
import { isTradeActive, STANDARD_TAKER_FEE_RATE, tradeExecution, tradingModeLabels, type PositionAction, type PositionRequest,
  type Trade, type TradeOrder, type TradingMode } from "@/lib/trading-types";
import { marketNumberFormatter } from "@/lib/market-number";
import { useRecordSelection } from "./use-record-selection";
import { useRememberedDetails } from "./use-remembered-details";
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
  entry: "开仓", "add-entry": "补仓", "stop-loss": "止损", "take-profit": "止盈", exit: "平仓", "limit-exit": "限价平仓",
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
        {trade.pendingLimitExitPercent != null && <div><dt>自动出场</dt><dd>正在核对并挂单，后台会自动处理</dd></div>}
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
              {order.limitPrice != null ? ` 限价 ${formatPrice(order.limitPrice)}` : ""}
              {order.execution ? ` 成交均价 ${formatPrice(order.execution.quote / order.execution.filled)}` : ""} · {
                order.kind === "limit-exit" && order.status === "placed" && order.execution ? "部分成交" :
                  order.kind === "add-entry" && order.status === "placed" ? "待核对" : orderStatusLabels[order.status]}
              {order.exchangeId && <> · 订单号 {order.exchangeId}</>}
              {order.error && <> · {order.error}</>}
            </li>)}
          </ul>
        </div>
      )}
    </>
  );
}

export function PositionControls({ trade, disabled, onManage }: {
  trade: Trade;
  disabled: boolean;
  onManage: (action: PositionAction) => Promise<unknown>;
}) {
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const order = trade.orders.findLast((order) => order.kind === "limit-exit" && order.status === "placed");
  const label = trade.side === "long" ? "限价平多" : "限价平空";

  async function manage(action: PositionAction, success: string, form?: HTMLFormElement) {
    setFeedback(null);
    try {
      await onManage(action);
      setFeedback({ error: false, text: success });
      form?.reset();
    } catch (caught) {
      setFeedback({ error: true, text: caught instanceof Error ? caught.message : "持仓操作失败。" });
    }
  }

  function submitLimit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const price = Number(new FormData(form).get("price"));
    if (!Number.isFinite(price) || price <= 0) {
      setFeedback({ error: true, text: "请输入大于 0 的平仓限价。" });
      return;
    }
    if (!window.confirm(`确认以限价 ${price} USDT 对 ${trade.symbol} 提交${label}单（${tradingModeLabels[trade.mode]}）？`)) return;
    void manage({ action: "limit-close", price }, "已提交限价平仓单，请查看订单明细。", form);
  }

  function submitProtection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const stop = fields.get("stopLossPrice");
    const take = fields.get("takeProfitPrice");
    const stopLossPrice = stop ? Number(stop) : undefined;
    const takeProfitPrice = take ? Number(take) : undefined;
    if ((stopLossPrice === undefined && takeProfitPrice === undefined) ||
        [stopLossPrice, takeProfitPrice].some((price) => price !== undefined && (!Number.isFinite(price) || price <= 0))) {
      setFeedback({ error: true, text: "请至少输入一个大于 0 的触发价。" });
      return;
    }
    void manage({ action: "set-protection", stopLossPrice, takeProfitPrice }, "币安保护单已更新。", form);
  }

  return <section className={styles.tradePositionControls} aria-label={`${trade.symbol} 持仓管理`}>
    {order ? <div className={styles.tradeActions}>
      <span>{label} {formatPrice(order.limitPrice ?? undefined)} USDT · {order.execution ? `已成交 ${order.execution.filled} / ` : ""}{order.amount}</span>
      <button type="button" disabled={disabled} onClick={() => void manage({ action: "cancel-limit-close" }, "已核对限价单终态，请查看订单明细。")}>撤销限价平仓单</button>
    </div> : <form className={styles.monitorForm} onSubmit={submitLimit}>
      <label>平仓限价（USDT） <input name="price" type="number" min={0} step="any" required disabled={disabled} /></label>
      <button type="submit" disabled={disabled}>{label}</button>
    </form>}
    <form className={styles.monitorForm} onSubmit={submitProtection}>
      <label>止损触发价 <input name="stopLossPrice" type="number" min={0} step="any" disabled={disabled}
        placeholder={trade.stopLoss?.toString()} /></label>
      <label>止盈触发价 <input name="takeProfitPrice" type="number" min={0} step="any" disabled={disabled}
        placeholder={trade.takeProfit?.toString()} /></label>
      <button type="submit" disabled={disabled}>设置止损止盈</button>
    </form>
    <small>限价单针对当前剩余仓位。持仓到期时，系统撤销未完成的限价单并市价平仓。</small>
    <small>止损和止盈按标记价触发，平掉对应方向的剩余仓位。只填写要修改的触发价，单位为 USDT。</small>
    {feedback && <div role={feedback.error ? "alert" : "status"}>{feedback.text}</div>}
  </section>;
}

export default function TradeRecords({ trades, activeMode, accountRevision, canDelete, onDelete, onClose, onManage }: {
  trades: readonly Trade[];
  activeMode: TradingMode;
  accountRevision?: string;
  canDelete: boolean;
  onDelete: (ids: readonly string[]) => Promise<void>;
  onClose: (tradeId: string) => Promise<unknown>;
  onManage: (request: PositionRequest) => Promise<unknown>;
}) {
  const details = useRememberedDetails("trade-records");
  const [closing, setClosing] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
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
  const canSelect = canDelete && closing === null && !managing;
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

  async function manage(tradeId: string, action: PositionAction) {
    if (!accountRevision) throw new Error("请重新读取币安账号状态。");
    setManaging(true);
    try {
      return await onManage({ ...action, tradeId, accountRevision });
    } finally {
      setManaging(false);
    }
  }

  return (
    <details className={styles.monitorFeature} {...details}>
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
                const manageable = trade.status === "open" && activeMode === trade.mode && !!accountRevision && trade.pendingLimitExitPercent == null;
                const confirmingEntry = trade.status === "opening" && trade.pendingLimitExitPercent != null;
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
                          {isExpanded ? "收起" : manageable ? "管理持仓" : "详情"}
                        </button>
                        {isTradeActive(trade) && <button type="button" className={styles.tradingClose}
                          disabled={deleting || closing !== null || managing || confirmingEntry || activeMode !== trade.mode} onClick={() => void close(trade)}>
                          {closing === trade.id ? "平仓中…" : "市价平仓"}
                        </button>}
                      </div>
                    </td>
                  </tr>
                  {isExpanded && <tr><td id={detailId} colSpan={COLUMN_COUNT} className={styles.tradeDetailCell}>
                    {manageable && <PositionControls trade={trade} disabled={deleting || closing !== null || managing}
                      onManage={(action) => manage(trade.id, action)} />}
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
