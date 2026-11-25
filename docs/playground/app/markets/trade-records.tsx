"use client";

import { useState } from "react";
import { isTradeActive, tradePnl, tradingModeLabels, type Trade, type TradeOrder, type TradingMode } from "@/lib/trading-types";
import { marketNumberFormatter } from "@/lib/market-number";
import styles from "./markets.module.css";

const formatPrice = marketNumberFormatter({ maximumSignificantDigits: 10 });
const formatUsdt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4, signDisplay: "exceptZero" });
const formatTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" });
const statusLabels: Record<Trade["status"], string> = {
  opening: "开仓中", open: "持仓中", closing: "平仓中", closed: "已平仓", failed: "失败",
};
const orderLabels: Record<TradeOrder["kind"], string> = {
  entry: "开仓", "stop-loss": "止损", "take-profit": "止盈", exit: "平仓",
};
const orderStatusLabels: Record<TradeOrder["status"], string> = {
  placed: "已挂单", filled: "已成交", canceled: "已撤销", triggered: "已触发", failed: "失败",
};

export default function TradeRecords({ trades, activeMode, onClose }: {
  trades: readonly Trade[];
  activeMode: TradingMode;
  onClose: (tradeId: string) => Promise<unknown>;
}) {
  const [closing, setClosing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const active = trades.filter(isTradeActive).length;

  async function close(trade: Trade) {
    if (!window.confirm(`确认按市价平掉 ${trade.symbol} ${trade.side === "long" ? "多仓" : "空仓"}（${tradingModeLabels[trade.mode]}）？`)) return;
    setClosing(trade.id);
    setError("");
    try {
      await onClose(trade.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "平仓失败。");
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
      {error && <p role="alert">{error}</p>}
      <div className={`${styles.tableScroll} ${styles.alertScroll}`}>
        <table className={styles.alertTable}>
          <thead><tr>
            <th scope="col">交易对</th><th scope="col">策略</th><th scope="col">账户</th><th scope="col">方向</th>
            <th scope="col">数量 / 金额</th><th scope="col">开仓价</th><th scope="col">止损 / 止盈</th>
            <th scope="col">状态</th><th scope="col">盈亏 (USDT)</th><th scope="col">开仓时间</th><th scope="col">订单</th>
            <th scope="col">操作</th>
          </tr></thead>
          <tbody>
            {trades.length === 0 && (
              <tr><td colSpan={12} className={styles.emptyTableCell}><span role="status">暂无下单记录。</span></td></tr>
            )}
            {trades.map((trade) => {
              const pnl = tradePnl(trade);
              return <tr key={trade.id}>
                <th scope="row">{trade.symbol}</th>
                <td title={trade.note}>{trade.strategy.name}</td>
                <td><span className={trade.mode === "live" ? styles.tradingLive : styles.tradingDemo}>
                  {tradingModeLabels[trade.mode]}</span></td>
                <td>{trade.side === "long" ? "做多" : "做空"} · {trade.leverage}x</td>
                <td>{trade.amount} / {formatPrice(trade.notional)}</td>
                <td>{formatPrice(trade.entryPrice ?? undefined)}</td>
                <td>{formatPrice(trade.stopLoss ?? undefined)} / {formatPrice(trade.takeProfit ?? undefined)}</td>
                <td title={trade.error ?? undefined}>
                  {statusLabels[trade.status]}
                  {trade.exitReason && <><br /><small>{trade.exitReason}</small></>}
                  {trade.error && <><br /><small role="alert">{trade.error}</small></>}
                  {isTradeActive(trade) && <><br /><small>到期 {formatTime.format(trade.deadline)}</small></>}
                </td>
                <td>{pnl === null ? "—" : formatUsdt.format(pnl)}</td>
                <td><time dateTime={new Date(trade.openedAt).toISOString()}>{formatTime.format(trade.openedAt)}</time></td>
                <td>
                  {trade.orders.map((order, index) => <div key={index} title={order.error ?? order.exchangeId ?? undefined}>
                    <small>{orderLabels[order.kind]} {order.side === "buy" ? "买" : "卖"}
                      {order.triggerPrice !== null ? ` @${formatPrice(order.triggerPrice)}` : ""}
                      {order.average !== null ? ` 均价 ${formatPrice(order.average)}` : ""} · {orderStatusLabels[order.status]}</small>
                  </div>)}
                </td>
                <td>
                  {isTradeActive(trade) && <button type="button" className={styles.tradingClose}
                    disabled={closing !== null || activeMode !== trade.mode} onClick={() => void close(trade)}>
                    {closing === trade.id ? "平仓中…" : "市价平仓"}
                  </button>}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      <p>盈亏按开仓价和平仓价估算，未扣手续费和资金费；止损止盈按触发价估算，实际成交价以币安为准。</p>
      </div>
    </details>
  );
}
