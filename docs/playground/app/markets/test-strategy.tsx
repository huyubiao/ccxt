"use client";

import { useState, type FormEvent } from "react";
import { tradingModeLabels, type TestOrderRequest, type TradingStatus } from "@/lib/trading-types";
import styles from "./markets.module.css";

type Props = {
  mode: "loading" | "local" | "unavailable";
  status: TradingStatus | null;
  error: string;
  onSubmit: (request: TestOrderRequest) => Promise<unknown>;
};

const formatBalance = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const defaults = { symbol: "DOGEUSDT", direction: "long", notional: "20", leverage: "2", stopLoss: "1", takeProfit: "1", hold: "5" };

export default function TestStrategy({ mode, status, error, onSubmit }: Props) {
  const [form, setForm] = useState(defaults);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const enabled = mode === "local" && status?.enabled === true;
  const live = status?.mode === "live";

  function update(field: keyof typeof defaults, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!status?.enabled || submitting) return;
    const request: TestOrderRequest = {
      symbol: form.symbol.trim().toUpperCase(),
      accountRevision: status.accountRevision,
      direction: form.direction as TestOrderRequest["direction"],
      notional: Number(form.notional),
      leverage: Math.trunc(Number(form.leverage)),
      stopLossPercent: Number(form.stopLoss),
      takeProfitPercent: Number(form.takeProfit),
      holdMinutes: Math.trunc(Number(form.hold)),
    };
    if (![request.notional, request.leverage, request.stopLossPercent, request.takeProfitPercent, request.holdMinutes]
      .every((value) => Number.isFinite(value) && value > 0)) {
      setMessage({ kind: "error", text: "请填写有效的正数。" });
      return;
    }
    const direction = request.direction === "long" ? "做多" : "做空";
    const confirmation = `${live ? "⚠️ 实盘，真实资金！\n\n" : ""}确认在【${tradingModeLabels[status.mode]}】下单？\n\n` +
      `${request.symbol} · ${direction} · ${request.notional} USDT · ${request.leverage} 倍\n` +
      `止损 ${request.stopLossPercent}% · 止盈 ${request.takeProfitPercent}% · ${request.holdMinutes} 分钟后自动平仓`;
    if (!window.confirm(confirmation)) return;
    setSubmitting(true);
    setMessage(null);
    try {
      await onSubmit(request);
      setMessage({ kind: "ok", text: "已下单并挂好止损止盈，请在「下单记录」查看。" });
    } catch (caught) {
      setMessage({ kind: "error", text: caught instanceof Error ? caught.message : "下单失败。" });
    } finally {
      setSubmitting(false);
    }
  }

  const balance = status?.balance;
  return (
    <details className={styles.monitorFeature}>
      <summary className={styles.monitorSummary}>
        <h3>测试策略 <small>{mode === "loading" ? "正在读取下单状态"
          : mode === "unavailable" ? "仅本地模式可用"
          : `${tradingModeLabels[status?.mode ?? "off"]}${status?.enabled ? "" : "（未就绪）"}`}</small></h3>
      </summary>
      <div className={styles.monitorBody}>
        <section className={`${styles.result} ${styles.monitorSettings}`} aria-label="测试策略下单">
          {mode === "unavailable" && <p role="status">下单只在本地启动（start-rust-markets.mjs）时可用。</p>}
          {status && <div className={styles.monitorHeading}>
            <span className={live ? styles.tradingLive : styles.tradingDemo}>{tradingModeLabels[status.mode]}</span>
            {balance && "available" in balance && <span>可用 {formatBalance.format(balance.available ?? 0)} USDT</span>}
            {balance && "error" in balance && <span role="alert">余额读取失败：{balance.error}</span>}
            <span>单笔上限 {status.limits.maxNotional} USDT · 杠杆 ≤ {status.limits.maxLeverage} 倍 · 同时最多 {status.limits.maxOpenTrades} 笔</span>
          </div>}
          {status?.problem && <p role="alert">下单未开启：{status.problem}</p>}
          {status && !status.problem && status.mode === "off" && <p role="status">
            请在上方「账号设置」连接币安模拟盘或实盘。
          </p>}
          {error && <p role="alert">{error}</p>}
          <form className={styles.monitorForm} onSubmit={submit}>
            <label htmlFor="test-symbol">交易对</label>
            <input id="test-symbol" value={form.symbol} onChange={(event) => update("symbol", event.target.value)} />
            <label htmlFor="test-direction">方向</label>
            <select id="test-direction" className={styles.tradingSelect} value={form.direction}
              onChange={(event) => update("direction", event.target.value)}>
              <option value="long">做多</option>
              <option value="short">做空</option>
            </select>
            <label htmlFor="test-notional">金额 (USDT)</label>
            <input id="test-notional" inputMode="decimal" value={form.notional} onChange={(event) => update("notional", event.target.value)} />
            <label htmlFor="test-leverage">杠杆</label>
            <input id="test-leverage" inputMode="numeric" value={form.leverage} onChange={(event) => update("leverage", event.target.value)} />
            <label htmlFor="test-stop">止损 %</label>
            <input id="test-stop" inputMode="decimal" value={form.stopLoss} onChange={(event) => update("stopLoss", event.target.value)} />
            <label htmlFor="test-profit">止盈 %</label>
            <input id="test-profit" inputMode="decimal" value={form.takeProfit} onChange={(event) => update("takeProfit", event.target.value)} />
            <label htmlFor="test-hold">持仓 (分钟)</label>
            <input id="test-hold" inputMode="numeric" value={form.hold} onChange={(event) => update("hold", event.target.value)} />
            <button type="submit" disabled={!enabled || submitting}>{submitting ? "正在下单…" : "运行测试策略"}</button>
          </form>
          {message && <p role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
          <div className={styles.monitorHelp}>
            <p><strong>做什么：</strong>按设定方向市价开仓，立即在交易所挂好止损、止盈条件单（按标记价触发），到时间还没触发就市价平仓。</p>
            <p>使用双向持仓。同一合约的多仓和空仓可同时存在，每个方向只管理一笔策略交易。</p>
          </div>
        </section>
      </div>
    </details>
  );
}
