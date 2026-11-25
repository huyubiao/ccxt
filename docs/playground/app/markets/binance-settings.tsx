"use client";

import { Fragment, useState, type FormEvent } from "react";
import { tradingModeLabels, type TradingAccountRequest, type TradingLoginMode, type TradingStatus } from "@/lib/trading-types";
import styles from "./markets.module.css";

export default function BinanceSettings({ availability, status, error, onChange }: {
  availability: "loading" | "local" | "unavailable";
  status: TradingStatus | null;
  error: string;
  onChange: (request: TradingAccountRequest) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<TradingLoginMode>("demo");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ error: boolean; text: string } | null>(null);
  const enabled = status?.enabled === true;
  const canChange = availability === "local" && status !== null && !pending;

  async function change(request: TradingAccountRequest) {
    if (!canChange) return;
    setPending(true);
    setResult(null);
    try {
      await onChange(request);
      setResult({ error: false, text: request.action === "login" ? "币安账号已登录。" : "币安账号已登出。" });
    } catch (caught) {
      setResult({ error: true, text: caught instanceof Error ? caught.message : "无法更改币安账号状态。" });
    } finally {
      setPending(false);
    }
  }

  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (enabled) return;
    const fields = new FormData(event.currentTarget);
    void change({ action: "login", mode, apiKey: String(fields.get("apiKey") ?? ""),
      secret: String(fields.get("secret") ?? ""), confirmLive: fields.has("confirmLive") });
  }

  return (
    <section className={`${styles.result} ${styles.monitorSettings} ${styles.notificationSettings}`} aria-labelledby="binance-account-heading">
      <h3 id="binance-account-heading">币安账号</h3>
      {availability === "unavailable" ? <p>在运行 Playground 的电脑上打开本机行情页进行配置。</p> : <>
        <p role="status">{enabled ? `已登录 ${tradingModeLabels[status.mode]}` : status ? "尚未登录" : "正在读取币安账号状态…"}
          {status?.balance && "available" in status.balance && status.balance.available !== null && ` · 可用 ${status.balance.available} USDT`}
        </p>
        {status?.problem && <p role="alert">{status.problem}</p>}
        {status?.balance && "error" in status.balance && <p role="alert">余额读取失败：{status.balance.error}</p>}
        {error && <p role="alert">{error}</p>}
        {status && (enabled ? (
          <div className={styles.monitorForm}>
            <button type="button" disabled={!canChange}
              onClick={() => void change({ action: "logout", accountRevision: status.accountRevision })}>
              {pending ? "正在登出…" : "登出"}
            </button>
          </div>
        ) : (
          <form className={`${styles.monitorForm} ${styles.notificationForm}`} onSubmit={login} autoComplete="off">
            <label htmlFor="binance-account-mode">账户模式</label>
            <select id="binance-account-mode" className={styles.tradingSelect} value={mode}
              onChange={(event) => { setMode(event.target.value as TradingLoginMode); setResult(null); }}
              disabled={!canChange}>
              <option value="demo">模拟盘</option>
              <option value="live">实盘</option>
            </select>
            <Fragment key={mode}>
              <label htmlFor="binance-api-key">API Key</label>
              <input id="binance-api-key" type="password" name="apiKey" autoComplete="off" spellCheck={false}
                maxLength={256} required disabled={!canChange} />
              <label htmlFor="binance-api-secret">API Secret</label>
              <input id="binance-api-secret" type="password" name="secret" autoComplete="new-password" spellCheck={false}
                maxLength={256} required disabled={!canChange} />
              {mode === "live" && <div><label className={styles.monitorSwitch}>
                <input type="checkbox" name="confirmLive" required disabled={!canChange} />确认启用真实资金下单
              </label></div>}
            </Fragment>
            <div className={styles.monitorForm}>
              <button type="submit" disabled={!canChange}>{pending ? "正在登录…" : "登录"}</button>
            </div>
          </form>
        ))}
        {status && !enabled && <p>币安 USDⓈ-M 合约账户须设为双向持仓。</p>}
        {result && <p role={result.error ? "alert" : "status"}>{result.text}</p>}
      </>}
    </section>
  );
}
