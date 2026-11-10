"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiUrl } from "@/lib/basePath";
import { CONTRACT_REFRESH_MS, type ContractDirectory } from "@/lib/market-lookup";
import {
  DEFAULT_ALERT_SECONDS, MAX_ALERT_SECONDS, parseAlertSeconds, parseAlertThreshold, recordDirectionalPrice, type DirectionalAlertState, type DirectionalThresholds,
  type AlertMarketContext, type AlertRatio,
} from "@/lib/price-alerts";
import styles from "./markets.module.css";

const STREAM = "wss://fstream.binance.com/market/ws/!miniTicker@arr";
const STORAGE_KEY = "ccxt-market-alert-threshold";
const WINDOW_STORAGE_KEY = "ccxt-market-alert-seconds";
const ENABLED_STORAGE_KEY = "ccxt-market-alert-enabled";
const NOTIFICATION_STORAGE_KEY = "ccxt-market-alert-notifications";
const DIRECTION_STORAGE_KEY = "ccxt-market-alert-directions";
const DEFAULT_THRESHOLDS: DirectionalThresholds = { up: null, down: -5 };
const formatPercent = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4, signDisplay: "exceptZero" });
const formatPrice = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 12 });
const formatTurnover = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const formatShare = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 });
const formatTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" });

type Alert = {
  symbol: string; time: number; price: number; previous: number; change: number; threshold: number; seconds: number;
  context?: AlertMarketContext | null;
};
type Tick = { e: string; s: string; E: number; c: string; st?: number };

function Ratio({ data }: { data: AlertRatio | null | undefined }) {
  if (!data) return "—";
  return <>{formatTurnover.format(data.ratio)} <small>多 {formatShare.format(data.long)} / 空 {formatShare.format(data.short)}</small>
    <small>{formatTime.format(data.time)}</small></>;
}

export default function MarketMonitor() {
  const [enabled, setEnabled] = useState(false);
  const [upInput, setUpInput] = useState("5");
  const [downInput, setDownInput] = useState("5");
  const [upSelected, setUpSelected] = useState(false);
  const [downSelected, setDownSelected] = useState(true);
  const [secondsInput, setSecondsInput] = useState(String(DEFAULT_ALERT_SECONDS));
  const [thresholds, setThresholds] = useState(DEFAULT_THRESHOLDS);
  const [seconds, setSeconds] = useState(DEFAULT_ALERT_SECONDS);
  const [invalid, setInvalid] = useState<"up" | "down" | "directions" | "seconds" | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [listed, setListed] = useState(0);
  const [observed, setObserved] = useState(0);
  const [directoryError, setDirectoryError] = useState(false);
  const [online, setOnline] = useState(false);
  const [notification, setNotification] = useState<NotificationPermission | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [requestingNotification, setRequestingNotification] = useState(false);
  const notify = useRef(false);
  const activeRule = useRef({ ...DEFAULT_THRESHOLDS, seconds: DEFAULT_ALERT_SECONDS });

  useEffect(() => {
    try {
      const legacy = parseAlertThreshold(localStorage.getItem(STORAGE_KEY) ?? "");
      const fallback: DirectionalThresholds = legacy === null ? DEFAULT_THRESHOLDS
        : legacy > 0 ? { up: legacy, down: null } : { up: null, down: legacy };
      let saved = fallback;
      const raw = localStorage.getItem(DIRECTION_STORAGE_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          const validUp = parsed.up === null || typeof parsed.up === "number" && Number.isFinite(parsed.up) && parsed.up > 0;
          const validDown = parsed.down === null || typeof parsed.down === "number" && Number.isFinite(parsed.down) && parsed.down < 0 && parsed.down > -100;
          if (validUp && validDown && (parsed.up !== null || parsed.down !== null)) saved = { up: parsed.up, down: parsed.down };
        } catch { /* Fall back to the previously saved signed threshold. */ }
      }
      activeRule.current = { ...activeRule.current, ...saved };
      setThresholds(saved);
      setUpSelected(saved.up !== null);
      setDownSelected(saved.down !== null);
      if (saved.up !== null) setUpInput(String(saved.up));
      if (saved.down !== null) setDownInput(String(Math.abs(saved.down)));
      const savedSeconds = parseAlertSeconds(localStorage.getItem(WINDOW_STORAGE_KEY) ?? "");
      if (savedSeconds !== null) {
        activeRule.current.seconds = savedSeconds;
        setSeconds(savedSeconds);
        setSecondsInput(String(savedSeconds));
      }
      setEnabled(localStorage.getItem(ENABLED_STORAGE_KEY) === "true");
    } catch {
      // Monitoring remains available without browser storage.
    }
    if ("Notification" in window) {
      const permission = Notification.permission;
      setNotification(permission);
      let saved: string | null = null;
      try { saved = localStorage.getItem(NOTIFICATION_STORAGE_KEY); } catch { /* Use browser permission. */ }
      notify.current = permission === "granted" && saved !== "false";
      setNotificationsEnabled(notify.current);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const lifecycle = new AbortController();
    let symbols = new Set<string>();
    const samples = new Map<string, DirectionalAlertState>();
    const latestPrices = new Map<string, { price: number; eventTime: number }>();
    let sampledRule = activeRule.current;
    let refreshTimer: ReturnType<typeof setTimeout>;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let socket: WebSocket | undefined;
    let lastFrame = 0;
    const pendingContext: Alert[] = [];
    let loadingContext = false;

    async function loadContext() {
      if (loadingContext) return;
      loadingContext = true;
      try {
        while (pendingContext.length && !lifecycle.signal.aborted) {
          const alert = pendingContext.shift()!;
          const params = new URLSearchParams({
            symbol: alert.symbol, seconds: String(alert.seconds), time: String(alert.time),
          });
          let context: AlertMarketContext | null = null;
          try {
            const response = await fetch(apiUrl(`/api/markets/alert-context?${params}`), { signal: lifecycle.signal });
            if (response.ok) context = await response.json();
          } catch {
            // Keep the price alert visible when the extra market data is unavailable.
          }
          if (!lifecycle.signal.aborted) {
            setAlerts((previous) => previous.map((row) => row === alert ? { ...row, context } : row));
          }
        }
      } finally {
        loadingContext = false;
      }
    }

    async function refreshContracts() {
      try {
        const response = await fetch(apiUrl("/api/markets/contracts"), {
          cache: "no-store", signal: lifecycle.signal,
        });
        if (!response.ok) throw new Error("Contract directory unavailable.");
        const directory: ContractDirectory = await response.json();
        if (lifecycle.signal.aborted) return;
        symbols = new Set(directory.contracts.map(({ id }) => id));
        for (const symbol of latestPrices.keys()) {
          if (!symbols.has(symbol)) {
            samples.delete(symbol);
            latestPrices.delete(symbol);
          }
        }
        setListed(symbols.size);
        setObserved(samples.size);
        setDirectoryError(false);
      } catch {
        if (!lifecycle.signal.aborted) setDirectoryError(true);
      } finally {
        if (!lifecycle.signal.aborted) refreshTimer = setTimeout(refreshContracts, CONTRACT_REFRESH_MS);
      }
    }

    function samplePrices() {
      if (socket?.readyState !== WebSocket.OPEN || Date.now() - lastFrame > 15000) return;
      const now = Date.now();
      const rule = activeRule.current;
      const { seconds } = rule;
      if (sampledRule !== rule) {
        samples.clear();
        sampledRule = rule;
      }
      const batch: Alert[] = [];
      for (const [symbol, { price }] of latestPrices) {
        const series = samples.get(symbol) ?? { up: { samples: [] }, down: { samples: [] } };
        const results = recordDirectionalPrice(series, { time: now, price }, rule, seconds);
        samples.set(symbol, series);
        for (const result of results) {
          batch.push({
            symbol, time: now, price, previous: result.reference.price,
            change: result.change, threshold: result.threshold, seconds,
          });
        }
      }
      setObserved(samples.size);
      if (!batch.length) return;
      setAlerts((previous) => [...batch, ...previous].sort((a, b) => b.time - a.time).slice(0, 100));
      pendingContext.push(...batch);
      if (pendingContext.length > 100) {
        const dropped = new Set(pendingContext.splice(0, pendingContext.length - 100));
        setAlerts((previous) => previous.map((row) => dropped.has(row) ? { ...row, context: null } : row));
      }
      void loadContext();
      if (notify.current && "Notification" in window && Notification.permission === "granted") {
        const first = batch[0];
        try {
          new Notification(batch.length === 1 ? `${first.symbol} ${first.seconds} 秒价格告警` : `${batch.length} 个交易对触发价格告警`, {
            body: `${first.symbol} ${formatPercent.format(first.change)}%`,
          });
        } catch {
          // The alert remains visible in the page.
        }
      }
    }

    function connect() {
      const connection = new WebSocket(STREAM);
      socket = connection;
      lastFrame = Date.now();
      connection.onmessage = ({ data }) => {
        let ticks: Tick[];
        try {
          const frame = JSON.parse(data);
          if (!Array.isArray(frame)) return;
          ticks = frame;
        } catch {
          return;
        }
        lastFrame = Date.now();
        setOnline(true);
        for (const tick of ticks) {
          if (tick?.e !== "24hrMiniTicker" || tick.st === 2 || !symbols.has(tick.s)) continue;
          const price = Number(tick.c);
          if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(tick.E) ||
              tick.E <= (latestPrices.get(tick.s)?.eventTime ?? 0)) continue;
          latestPrices.set(tick.s, { price, eventTime: tick.E });
        }
      };
      connection.onerror = () => connection.close();
      connection.onclose = () => {
        samples.clear();
        latestPrices.clear();
        setObserved(0);
        setOnline(false);
        reconnectTimer = setTimeout(connect, 5000);
      };
    }

    const sampling = setInterval(samplePrices, 1000);
    const watchdog = setInterval(() => {
      if (Date.now() - lastFrame > 15000) socket?.close();
    }, 5000);
    void refreshContracts();
    connect();
    return () => {
      lifecycle.abort();
      clearInterval(sampling);
      clearInterval(watchdog);
      clearTimeout(refreshTimer);
      clearTimeout(reconnectTimer);
      if (socket) {
        socket.onmessage = socket.onerror = socket.onclose = null;
        socket.close();
      }
    };
  }, [enabled]);

  async function toggleNotifications() {
    if (!("Notification" in window)) return;
    let next = false;
    if (!notify.current) {
      setRequestingNotification(true);
      try {
        const permission = Notification.permission === "default"
          ? await Notification.requestPermission() : Notification.permission;
        setNotification(permission);
        next = permission === "granted";
      } catch {
        setNotification(Notification.permission);
      } finally {
        setRequestingNotification(false);
      }
    }
    notify.current = next;
    setNotificationsEnabled(next);
    try { localStorage.setItem(NOTIFICATION_STORAGE_KEY, String(next)); } catch { /* Keep the session setting. */ }
  }

  function toggleMonitoring(next: boolean) {
    setEnabled(next);
    if (!next) {
      setOnline(false);
      setDirectoryError(false);
      setObserved(0);
      setListed(0);
      setAlerts((previous) => previous.map((row) => row.context === undefined ? { ...row, context: null } : row));
    }
    try {
      localStorage.setItem(ENABLED_STORAGE_KEY, String(next));
    } catch {
      // The current session still uses the switch state.
    }
  }

  function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const up = upSelected ? parseAlertThreshold(upInput) : null;
    const downValue = downSelected ? parseAlertThreshold(downInput) : null;
    const nextSeconds = parseAlertSeconds(secondsInput);
    const error = nextSeconds === null ? "seconds" : !upSelected && !downSelected ? "directions"
      : upSelected && (up === null || up <= 0) ? "up"
      : downSelected && (downValue === null || Math.abs(downValue) >= 100) ? "down" : null;
    setInvalid(error);
    if (error || nextSeconds === null) return;
    const next: DirectionalThresholds = { up, down: downValue === null ? null : -Math.abs(downValue) };
    activeRule.current = { ...next, seconds: nextSeconds };
    setThresholds(next);
    setSeconds(nextSeconds);
    try {
      localStorage.setItem(DIRECTION_STORAGE_KEY, JSON.stringify(next));
      localStorage.setItem(WINDOW_STORAGE_KEY, String(nextSeconds));
    } catch {
      // The current session still uses the new threshold.
    }
  }

  return (
    <details className={styles.monitorFeature} open>
      <summary className={styles.monitorSummary}>
        <h3>插针狙击 <small>{enabled ? "已启动 · 折叠后继续监控" : "已停止"}</small></h3>
      </summary>
      <div className={styles.monitorBody}>
        <div className={styles.monitorHeading}>
          <label className={styles.monitorSwitch}>
            <input type="checkbox" role="switch" checked={enabled} onChange={(event) => toggleMonitoring(event.target.checked)} />
            启用策略
          </label>
        </div>
        <section className={`${styles.result} ${styles.monitorSettings}`} aria-label="告警设置">
          <form className={styles.monitorForm} onSubmit={saveSettings}>
            <label htmlFor="alert-seconds">时间窗口 (秒)</label>
            <input id="alert-seconds" inputMode="numeric" value={secondsInput} onChange={(event) => setSecondsInput(event.target.value)} aria-invalid={invalid === "seconds"} placeholder="180" />
            <label className={styles.monitorSwitch}>
              <input type="checkbox" checked={upSelected} onChange={(event) => setUpSelected(event.target.checked)} />
              上涨告警 (%)
            </label>
            <input aria-label="上涨告警阈值" value={upInput} disabled={!upSelected} onChange={(event) => setUpInput(event.target.value)} aria-invalid={invalid === "up"} placeholder="5" />
            <label className={styles.monitorSwitch}>
              <input type="checkbox" checked={downSelected} onChange={(event) => setDownSelected(event.target.checked)} />
              下跌告警 (%)
            </label>
            <input aria-label="下跌告警阈值" value={downInput} disabled={!downSelected} onChange={(event) => setDownInput(event.target.value)} aria-invalid={invalid === "down"} placeholder="5" />
            <button type="submit">保存设置</button>
            {notification !== null && <button type="button" disabled={requestingNotification}
              onClick={() => void toggleNotifications()}>
              {notificationsEnabled ? "停止桌面通知" : "开启桌面通知"}
            </button>}
          </form>
          {notification === "denied" && <p role="status">浏览器已阻止桌面通知。请在站点权限中允许通知，再点击开启。</p>}
          {notification === null && <p role="status">当前浏览器环境无法发送桌面通知。</p>}
          {invalid === "seconds" && <p role="alert">请输入 1 至 {MAX_ALERT_SECONDS} 之间的整数秒数。</p>}
          {invalid === "directions" && <p role="alert">请至少勾选上涨告警或下跌告警。</p>}
          {invalid === "up" && <p role="alert">上涨阈值请输入大于 0 的百分比。</p>}
          {invalid === "down" && <p role="alert">下跌幅度请输入大于 0 且小于 100 的百分比。</p>}
          <p role="status">
            当前设置 {seconds} 秒 / {[thresholds.up !== null ? `上涨 ${formatPercent.format(thresholds.up)}%` : null, thresholds.down !== null ? `下跌 ${formatPercent.format(thresholds.down)}%` : null].filter(Boolean).join(" / ")} · {enabled
              ? `${online ? "行情已连接" : "正在连接行情"} · 已接收 ${observed}/${listed} 个交易对`
              : "监控已停止"}
          </p>
          {directoryError && <p role="status">合约列表同步失败，正在重试。</p>}
          <p>监控币安 USDT 本位永续合约。请保持行情页打开，切换币种或交易所时监控会继续运行。</p>
          <p>告警规则：1.启动后，以“当前价格”为基准，若前 {seconds} 秒内存在涨跌幅度达到告警阈值则触发告警。2.触发告警后，以触发价作为新基准继续监控 {seconds} 秒，无二次告警则回到规则1。</p>
          <p>上涨、下跌可单独或同时启用，分别维护触发价基准。保存设置后重新采样。每秒采样一次最新收到的价格。涨跌幅 =（当前价 − 参考价）÷ 参考价。达到或超过阈值时触发。</p>
        </section>
        <section className={styles.turnover} aria-label="告警记录">
          <h4>告警记录 <span>最近 100 条</span></h4>
          <p role="status">{alerts.length ? `最新告警 ${alerts[0].symbol} ${formatPercent.format(alerts[0].change)}%` : "暂无告警。"}</p>
          {alerts.length > 0 && <div className={`${styles.tableScroll} ${styles.alertScroll}`}>
            <table className={styles.alertTable}>
              <thead><tr>
                <th scope="col">交易对</th><th scope="col">触发时间</th><th scope="col">参考价 (USDT)</th>
                <th scope="col">触发价 (USDT)</th><th scope="col">涨跌幅</th><th scope="col">阈值</th><th scope="col">窗口 (秒)</th>
                <th scope="col">窗口成交额 (USDT)</th>
                <th scope="col">币安全体账户多空比</th><th scope="col">OKX 全体账户多空比</th>
                <th scope="col">币安大户多空持仓比</th><th scope="col">OKX 大户多空持仓比</th>
              </tr></thead>
              <tbody>
                {alerts.map((alert) => <tr key={`${alert.symbol}:${alert.time}:${alert.threshold}`}>
                  <th scope="row">{alert.symbol}</th>
                  <td><time dateTime={new Date(alert.time).toISOString()}>{formatTime.format(alert.time)}</time></td>
                  <td>{formatPrice.format(alert.previous)}</td>
                  <td>{formatPrice.format(alert.price)}</td>
                  <td className={alert.change < 0 ? styles.sell : styles.buy}>{formatPercent.format(alert.change)}%</td>
                  <td>{formatPercent.format(alert.threshold)}%</td>
                  <td>{alert.seconds}</td>
                  {alert.context === undefined ? <td colSpan={5}>正在补充行情…</td> : <>
                    <td>{alert.context?.turnover == null ? "—" : formatTurnover.format(alert.context.turnover)}</td>
                    <td><Ratio data={alert.context?.binanceAccounts} /></td>
                    <td><Ratio data={alert.context?.okxAccounts} /></td>
                    <td><Ratio data={alert.context?.binancePositions} /></td>
                    <td><Ratio data={alert.context?.okxPositions} /></td>
                  </>}
                </tr>)}
              </tbody>
            </table>
          </div>}
          {alerts.length > 0 && <p>多空比使用告警时各平台最近一期 5 分钟统计。币安大户按保证金余额取前 20%，OKX 按未平仓头寸价值取前 5%。— 表示无匹配合约或数据暂不可用。</p>}
        </section>
      </div>
    </details>
  );
}
