"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { apiUrl } from "@/lib/basePath";
import { getContractCoins, type MarketInstrument } from "@/lib/market-lookup";
import {
  DEFAULT_ALERT_SECONDS, DEFAULT_TURNOVER_MULTIPLE, MAX_ALERT_SECONDS, MIN_ALERT_PERCENT, TURNOVER_BASELINE_MINUTES,
  getTurnoverMultiple, parseAlertSeconds, parseAlertThreshold, parseTurnoverMultiple,
  recordPriceLevel, restoreAlertSeconds, restoreAlertThreshold, settlePriceSeries,
  type AlertMarketContext, type AlertRatio, type AlertTurnover, type DirectionalThresholds,
  type LeveledPriceState, type OkxAlertRatio, type PriceAlertLevel, type PriceAlertSeries,
} from "@/lib/price-alerts";
import SpikeForecastPanel from "./spike-forecast-panel";
import SpikeRecords, { readSpikeRecords, saveSpikeRecords, SPIKE_RECORD_LIMIT, type SpikeRecord } from "./spike-records";
import { useSpikeForecasts } from "./use-spike-forecasts";
import { useStrategyNotifications } from "./use-strategy-notifications";
import DingTalkSettings from "./dingtalk-settings";
import styles from "./markets.module.css";

const STREAM = "wss://fstream.binance.com/market/ws/!miniTicker@arr";
const STORAGE_KEY = "ccxt-market-alert-threshold";
const WINDOW_STORAGE_KEY = "ccxt-market-alert-seconds";
const ENABLED_STORAGE_KEY = "ccxt-market-alert-enabled";
const DINGTALK_NOTIFICATION_STORAGE_KEY = "ccxt-market-alert-dingtalk-notifications";
const DIRECTION_STORAGE_KEY = "ccxt-market-alert-directions";
const TURNOVER_STORAGE_KEY = "ccxt-market-alert-turnover-multiple";
const QUEUE_LIMIT = 100;
const TURNOVER_CONCURRENCY = 2;
const DEFAULT_THRESHOLDS: DirectionalThresholds = { up: null, down: -5 };
const formatPercent = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4, signDisplay: "exceptZero" });
const formatPrice = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 12 });
const formatTurnover = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const formatShare = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 });
const formatTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" });

type Alert = SpikeRecord & {
  context?: AlertMarketContext | "request-failed" | "queue-skipped" | "monitor-stopped";
};
type TurnoverJob = {
  record: SpikeRecord & { requiredMultiple: number };
  state: LeveledPriceState;
  series: PriceAlertSeries;
};
type Tick = { e: string; s: string; E: number; c: string; st?: number };

function levelRecord(symbol: string, move: PriceAlertLevel, threshold: number, seconds: number) {
  return {
    symbol, time: move.sample.sampledAt ?? move.sample.time, price: move.sample.price, previous: move.previous,
    change: move.change, threshold, seconds, level: move.level,
  };
}

function Ratio({ data }: { data: AlertRatio | null | undefined }) {
  if (!data) return "—";
  return <>{formatTurnover.format(data.ratio)} <small>多 {formatShare.format(data.long)} / 空 {formatShare.format(data.short)}</small>
    <small>{formatTime.format(data.time)}</small></>;
}

const okxRatioMessages = {
  "no-contract": "OKX 无此币种的 USDT 永续合约",
  "ambiguous-contract": "OKX 有多个候选合约，无法唯一匹配",
  "directory-unavailable": "OKX 合约名单查询失败",
  "no-sample": "OKX 未返回告警时可用的 5 分钟统计",
  "rate-limited": "OKX 多空比接口限流",
  "request-failed": "OKX 多空比接口请求失败",
};
const alertContextMessages = {
  "request-failed": "告警行情请求失败",
  "queue-skipped": "告警过多，已跳过行情补查",
  "monitor-stopped": "监控已停止，行情补查取消",
};

function OkxRatio({ result, reason }: { result?: OkxAlertRatio; reason: string }) {
  if (!result) return <small>{reason}</small>;
  return result.status === "ok" ? <Ratio data={result.data} /> : <small>{okxRatioMessages[result.status]}</small>;
}

export default function MarketMonitor({ contracts, coinCount, directoryError, showRecords }: {
  contracts: readonly MarketInstrument[] | undefined;
  coinCount: number | null;
  directoryError: boolean;
  showRecords: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [upInput, setUpInput] = useState("5");
  const [downInput, setDownInput] = useState("5");
  const [upSelected, setUpSelected] = useState(false);
  const [downSelected, setDownSelected] = useState(true);
  const [secondsInput, setSecondsInput] = useState(String(DEFAULT_ALERT_SECONDS));
  const [thresholds, setThresholds] = useState(DEFAULT_THRESHOLDS);
  const [seconds, setSeconds] = useState(DEFAULT_ALERT_SECONDS);
  const [turnoverInput, setTurnoverInput] = useState(String(DEFAULT_TURNOVER_MULTIPLE));
  const [turnoverMultiple, setTurnoverMultiple] = useState(DEFAULT_TURNOVER_MULTIPLE);
  const [invalid, setInvalid] = useState<"up" | "down" | "directions" | "seconds" | "turnover" | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [spikes, setSpikes] = useState<SpikeRecord[]>([]);
  const [recordsReady, setRecordsReady] = useState(false);
  const { records: forecasts, addAlerts: addForecastAlerts } = useSpikeForecasts();
  const strategyNotifications = useStrategyNotifications();
  const { config: dingTalkConfig, configMessage: dingTalkConfigMessage, notifyStrategy } = strategyNotifications;
  const [observedSymbols, setObservedSymbols] = useState<ReadonlySet<string>>(() => new Set());
  const [online, setOnline] = useState(false);
  const [dingTalkEnabled, setDingTalkEnabled] = useState(false);
  const notifyDingTalk = useRef(false);
  const activeRule = useRef<DirectionalThresholds & { seconds: number; turnoverMultiple: number }>({
    ...DEFAULT_THRESHOLDS, seconds: DEFAULT_ALERT_SECONDS, turnoverMultiple: DEFAULT_TURNOVER_MULTIPLE,
  });
  const symbols = useMemo(() => enabled && contracts ? new Set(contracts.map(({ id }) => id)) : null, [enabled, contracts]);
  const activeSymbols = useRef(symbols);
  const hasSymbols = !!symbols?.size;
  const observedCoins = contracts ? getContractCoins(contracts, observedSymbols).size : 0;

  useLayoutEffect(() => {
    activeSymbols.current = symbols;
  }, [symbols]);

  useEffect(() => {
    setSpikes(readSpikeRecords());
    setRecordsReady(true);
    try {
      const legacy = restoreAlertThreshold(localStorage.getItem(STORAGE_KEY) ?? "");
      const fallback: DirectionalThresholds = legacy === null ? DEFAULT_THRESHOLDS
        : legacy > 0 ? { up: legacy, down: null } : { up: null, down: legacy };
      let saved = fallback;
      const raw = localStorage.getItem(DIRECTION_STORAGE_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          const up = typeof parsed.up === "number" ? restoreAlertThreshold(String(parsed.up)) : null;
          const down = typeof parsed.down === "number" ? restoreAlertThreshold(String(parsed.down)) : null;
          const validUp = parsed.up === null || (up !== null && up > 0);
          const validDown = parsed.down === null || (down !== null && down < 0);
          if (validUp && validDown && (up !== null || down !== null)) saved = { up, down };
        } catch { /* Fall back to the previously saved signed threshold. */ }
      }
      activeRule.current = { ...activeRule.current, ...saved };
      setThresholds(saved);
      setUpSelected(saved.up !== null);
      setDownSelected(saved.down !== null);
      if (saved.up !== null) setUpInput(String(saved.up));
      if (saved.down !== null) setDownInput(String(Math.abs(saved.down)));
      const savedSeconds = restoreAlertSeconds(localStorage.getItem(WINDOW_STORAGE_KEY) ?? "");
      if (savedSeconds !== null) {
        activeRule.current.seconds = savedSeconds;
        setSeconds(savedSeconds);
        setSecondsInput(String(savedSeconds));
      }
      const savedMultiple = parseTurnoverMultiple(localStorage.getItem(TURNOVER_STORAGE_KEY) ?? "");
      if (savedMultiple !== null) {
        activeRule.current.turnoverMultiple = savedMultiple;
        setTurnoverMultiple(savedMultiple);
        setTurnoverInput(String(savedMultiple));
      }
      setEnabled(localStorage.getItem(ENABLED_STORAGE_KEY) === "true");
    } catch {
      // Monitoring remains available without browser storage.
    }
    function restoreDingTalkPreference() {
      try {
        notifyDingTalk.current = localStorage.getItem(DINGTALK_NOTIFICATION_STORAGE_KEY) === "true";
        setDingTalkEnabled(notifyDingTalk.current);
      } catch { /* Keep the session setting. */ }
    }
    function syncDingTalkPreference(event: StorageEvent) {
      if (event.key === DINGTALK_NOTIFICATION_STORAGE_KEY || event.key === null) restoreDingTalkPreference();
    }
    restoreDingTalkPreference();
    window.addEventListener("storage", syncDingTalkPreference);
    return () => window.removeEventListener("storage", syncDingTalkPreference);
  }, []);

  useEffect(() => {
    if (recordsReady) saveSpikeRecords(spikes);
  }, [recordsReady, spikes]);

  useEffect(() => {
    if (!hasSymbols) return;
    const lifecycle = new AbortController();
    let sampledSymbols = activeSymbols.current;
    const samples = new Map<string, Record<keyof DirectionalThresholds, LeveledPriceState>>();
    const latestPrices = new Map<string, { price: number; eventTime: number }>();
    let sampledRule = activeRule.current;
    let samplingTimer: ReturnType<typeof setTimeout>;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let socket: WebSocket | undefined;
    let lastFrame = 0;
    const pendingTurnover: TurnoverJob[] = [];
    let turnoverScope = new AbortController();
    let checkingTurnover = 0;
    const pendingContext: Alert[] = [];
    let loadingContext = false;

    async function fetchAlertData<T>(record: Pick<Alert, "symbol" | "seconds" | "time">, view: "turnover" | "ratios",
      signal = lifecycle.signal): Promise<T> {
      const params = new URLSearchParams({
        symbol: record.symbol, seconds: String(record.seconds), time: String(record.time), view,
      });
      const response = await fetch(apiUrl(`/api/markets/alert-context?${params}`), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
      });
      if (!response.ok) throw new Error("Alert data unavailable.");
      return response.json();
    }

    async function loadContext() {
      if (loadingContext) return;
      loadingContext = true;
      try {
        while (pendingContext.length && !lifecycle.signal.aborted) {
          const alert = pendingContext.shift()!;
          const context = await fetchAlertData<AlertMarketContext>(alert, "ratios").catch(() => "request-failed" as const);
          if (!lifecycle.signal.aborted) {
            setAlerts((previous) => previous.map((row) => row === alert ? { ...row, context } : row));
          }
        }
      } finally {
        loadingContext = false;
      }
    }

    function addSpikeRecords(batch: SpikeRecord[]) {
      setSpikes((current) => [...batch, ...current].sort((a, b) => b.time - a.time).slice(0, SPIKE_RECORD_LIMIT));
    }

    function confirmAlert(record: SpikeRecord) {
      const alert: Alert = { ...record };
      setAlerts((current) => [alert, ...current].sort((a, b) => b.time - a.time).slice(0, SPIKE_RECORD_LIMIT));
      if (notifyDingTalk.current) {
        const { symbol, seconds, change, level, time, price, previous, threshold, volume } = record;
        notifyStrategy({ kind: "market-spike", symbol, seconds, change, level, time, price, previous, threshold, multiple: volume?.multiple });
      }
      addForecastAlerts([alert]);
      pendingContext.push(alert);
      if (pendingContext.length > QUEUE_LIMIT) {
        const dropped = pendingContext.shift();
        setAlerts((current) => current.map((row) => row === dropped ? { ...row, context: "queue-skipped" } : row));
      }
      void loadContext();
    }

    function resetPriceMonitoring() {
      samples.clear();
      pendingTurnover.length = 0;
      turnoverScope.abort();
      turnoverScope = new AbortController();
      setSpikes((current) => current.map((row) => row.status === "pending" ? { ...row, status: "interrupted" } : row));
    }

    function syncRule() {
      const rule = activeRule.current;
      if (sampledRule.seconds !== rule.seconds || sampledRule.up !== rule.up || sampledRule.down !== rule.down) {
        resetPriceMonitoring();
      }
      sampledRule = rule;
      return rule;
    }

    async function checkTurnover({ record, state, series }: TurnoverJob) {
      const signal = turnoverScope.signal;
      const data = await fetchAlertData<AlertTurnover>(record, "turnover", signal).catch(() => null);
      if (lifecycle.signal.aborted || signal.aborted) return;
      syncRule();
      if (signal.aborted) return;
      const direction = record.threshold > 0 ? "up" : "down";
      if (!activeSymbols.current?.has(record.symbol) || samples.get(record.symbol)?.[direction] !== state) {
        settlePriceSeries(state, series, false);
        setSpikes((current) => current.map((row) => row === record ? { ...row, status: "interrupted" } : row));
        return;
      }
      const multiple = data ? getTurnoverMultiple(data) : null;
      const latest = settlePriceSeries(state, series, multiple !== null && multiple >= record.requiredMultiple);
      const upgraded = latest !== null && latest.level > record.level;
      const result: SpikeRecord = {
        ...record,
        status: latest ? upgraded ? "upgraded" : "alerted" : multiple === null ? "unavailable" : "below-threshold",
        volume: data ? { ...data, multiple } : undefined,
      };
      setSpikes((current) => current.map((row) => row === record ? result : row));
      if (latest && upgraded) {
        const alert: SpikeRecord = {
          ...levelRecord(record.symbol, latest, record.threshold, record.seconds),
          status: "alerted", requiredMultiple: null,
        };
        addSpikeRecords([alert]);
        confirmAlert(alert);
      } else if (latest) {
        confirmAlert(result);
      }
    }

    function processTurnoverQueue() {
      while (!lifecycle.signal.aborted && checkingTurnover < TURNOVER_CONCURRENCY && pendingTurnover.length) {
        const job = pendingTurnover.shift()!;
        checkingTurnover++;
        void checkTurnover(job).finally(() => {
          checkingTurnover--;
          processTurnoverQueue();
        });
      }
    }

    function syncSymbols() {
      if (sampledSymbols === activeSymbols.current) return;
      sampledSymbols = activeSymbols.current;
      const previousSize = latestPrices.size;
      for (const symbol of latestPrices.keys()) {
        if (!sampledSymbols?.has(symbol)) {
          samples.delete(symbol);
          latestPrices.delete(symbol);
        }
      }
      if (latestPrices.size !== previousSize) setObservedSymbols(new Set(latestPrices.keys()));
    }

    function samplePrices() {
      syncSymbols();
      if (socket?.readyState !== WebSocket.OPEN || Date.now() - lastFrame > 15000) return;
      const sampledAt = Date.now();
      const time = Math.floor(sampledAt / 1000) * 1000;
      const rule = syncRule();
      const { seconds } = rule;
      const batch: SpikeRecord[] = [];
      for (const [symbol, { price }] of latestPrices) {
        const series = samples.get(symbol) ?? { up: { samples: [] }, down: { samples: [] } };
        samples.set(symbol, series);
        for (const direction of ["up", "down"] as const) {
          const threshold = rule[direction];
          if (threshold === null) continue;
          const state = series[direction];
          const result = recordPriceLevel(state, { time, price, sampledAt }, threshold, seconds);
          if (!result) continue;
          const details = levelRecord(symbol, result.move, threshold, seconds);
          if (result.needsTurnover) {
            const record = { ...details, requiredMultiple: rule.turnoverMultiple, status: "pending" as const };
            batch.push(record);
            pendingTurnover.push({ record, state, series: result.series });
          } else {
            const record: SpikeRecord = { ...details, requiredMultiple: null, status: "alerted" };
            batch.push(record);
            confirmAlert(record);
          }
        }
      }
      if (!batch.length) return;
      addSpikeRecords(batch);
      if (pendingTurnover.length > QUEUE_LIMIT) {
        const dropped = new Set<SpikeRecord>();
        for (const job of pendingTurnover.splice(0, pendingTurnover.length - QUEUE_LIMIT)) {
          settlePriceSeries(job.state, job.series, false);
          dropped.add(job.record);
        }
        setSpikes((current) => current.map((row) => dropped.has(row) ? { ...row, status: "skipped" } : row));
      }
      processTurnoverQueue();
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
        syncSymbols();
        const previousSize = latestPrices.size;
        for (const tick of ticks) {
          if (tick?.e !== "24hrMiniTicker" || tick.st === 2 || !sampledSymbols?.has(tick.s)) continue;
          const price = Number(tick.c);
          if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(tick.E) ||
              tick.E <= (latestPrices.get(tick.s)?.eventTime ?? 0)) continue;
          latestPrices.set(tick.s, { price, eventTime: tick.E });
        }
        if (latestPrices.size !== previousSize) setObservedSymbols(new Set(latestPrices.keys()));
      };
      connection.onerror = () => connection.close();
      connection.onclose = () => {
        resetPriceMonitoring();
        latestPrices.clear();
        setObservedSymbols(new Set());
        setOnline(false);
        reconnectTimer = setTimeout(connect, 5000);
      };
    }

    function scheduleSampling() {
      samplingTimer = setTimeout(() => {
        samplePrices();
        scheduleSampling();
      }, 1000 - Date.now() % 1000);
    }

    connect();
    scheduleSampling();
    const watchdog = setInterval(() => {
      if (Date.now() - lastFrame > 15000) socket?.close();
    }, 5000);
    return () => {
      lifecycle.abort();
      turnoverScope.abort();
      clearTimeout(samplingTimer);
      clearInterval(watchdog);
      clearTimeout(reconnectTimer);
      if (socket) {
        socket.onmessage = socket.onerror = socket.onclose = null;
        socket.close();
      }
      setOnline(false);
      setObservedSymbols(new Set());
      setSpikes((current) => current.map((row) => row.status === "pending" ? { ...row, status: "interrupted" } : row));
      setAlerts((previous) => previous.map((row) => row.context === undefined ? { ...row, context: "monitor-stopped" } : row));
    };
  }, [hasSymbols, addForecastAlerts, notifyStrategy]);

  function toggleDingTalkNotifications() {
    const next = !notifyDingTalk.current;
    if (next && dingTalkConfig !== "ready") {
      document.getElementById("dingtalk-heading")?.focus();
      return;
    }
    notifyDingTalk.current = next;
    setDingTalkEnabled(next);
    try { localStorage.setItem(DINGTALK_NOTIFICATION_STORAGE_KEY, String(next)); } catch { /* Keep the session setting. */ }
  }

  function toggleMonitoring(next: boolean) {
    setEnabled(next);
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
    const nextMultiple = parseTurnoverMultiple(turnoverInput);
    const error = nextSeconds === null ? "seconds" : !upSelected && !downSelected ? "directions"
      : upSelected && (up === null || up <= 0) ? "up"
      : downSelected && (downValue === null || Math.abs(downValue) >= 100) ? "down"
      : nextMultiple === null ? "turnover" : null;
    setInvalid(error);
    if (error || nextSeconds === null || nextMultiple === null) return;
    const next: DirectionalThresholds = { up, down: downValue === null ? null : -Math.abs(downValue) };
    activeRule.current = { ...next, seconds: nextSeconds, turnoverMultiple: nextMultiple };
    setThresholds(next);
    setSeconds(nextSeconds);
    setTurnoverMultiple(nextMultiple);
    try {
      localStorage.setItem(DIRECTION_STORAGE_KEY, JSON.stringify(next));
      localStorage.setItem(WINDOW_STORAGE_KEY, String(nextSeconds));
      localStorage.setItem(TURNOVER_STORAGE_KEY, String(nextMultiple));
    } catch {
      // The current session still uses the new threshold.
    }
  }

  const strategy = (
    <details className={styles.monitorFeature} open>
      <summary className={styles.monitorSummary}>
        <h3>异动监控 <small>{enabled ? "已启动 · 折叠后继续监控" : "已停止"}</small></h3>
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
            <label htmlFor="alert-seconds">时间窗口（1–{MAX_ALERT_SECONDS} 秒）</label>
            <input id="alert-seconds" inputMode="numeric" value={secondsInput} onChange={(event) => setSecondsInput(event.target.value)}
              aria-invalid={invalid === "seconds"} aria-describedby="alert-window-help" placeholder={String(DEFAULT_ALERT_SECONDS)} />
            <label className={styles.monitorSwitch}>
              <input type="checkbox" checked={upSelected} onChange={(event) => setUpSelected(event.target.checked)} aria-describedby="alert-up-help" />
              上涨幅度（≥ {MIN_ALERT_PERCENT}%）
            </label>
            <input aria-label="上涨阈值" value={upInput} disabled={!upSelected} onChange={(event) => setUpInput(event.target.value)}
              aria-invalid={invalid === "up"} aria-describedby="alert-up-help" placeholder="5" />
            <label className={styles.monitorSwitch}>
              <input type="checkbox" checked={downSelected} onChange={(event) => setDownSelected(event.target.checked)} aria-describedby="alert-down-help" />
              下跌幅度（≥ {MIN_ALERT_PERCENT}%）
            </label>
            <input aria-label="下跌阈值" value={downInput} disabled={!downSelected} onChange={(event) => setDownInput(event.target.value)}
              aria-invalid={invalid === "down"} aria-describedby="alert-down-help" placeholder="5" />
            <label htmlFor="alert-turnover-multiple">告警成交额倍数</label>
            <input id="alert-turnover-multiple" inputMode="decimal" value={turnoverInput} onChange={(event) => setTurnoverInput(event.target.value)}
              aria-invalid={invalid === "turnover"} aria-describedby="alert-turnover-help alert-turnover-baseline" />
            <button type="submit">保存设置</button>
            <button type="button" disabled={!dingTalkEnabled && dingTalkConfig === "checking"}
              aria-describedby="market-spike-dingtalk-status" onClick={toggleDingTalkNotifications}>
              {dingTalkEnabled ? "停止钉钉通知" : "开启钉钉通知"}
            </button>
          </form>
          <p id="market-spike-dingtalk-status" role="status">
            异动监控的钉钉通知{dingTalkEnabled ? "已开启" : "已关闭"}。
            {dingTalkConfig === "ready" ? (dingTalkEnabled ? "确认的告警将推送到钉钉群机器人。" : "")
              : dingTalkConfig === "checking" ? dingTalkConfigMessage
                : `${dingTalkConfigMessage}。请到「钉钉推送」查看。`}
          </p>
          {invalid === "seconds" && <p role="alert">请输入 1 至 {MAX_ALERT_SECONDS} 之间的整数秒数。</p>}
          {invalid === "directions" && <p role="alert">请至少勾选上涨幅度或下跌幅度。</p>}
          {invalid === "up" && <p role="alert">上涨阈值须至少为 {MIN_ALERT_PERCENT}%。</p>}
          {invalid === "down" && <p role="alert">下跌幅度须至少为 {MIN_ALERT_PERCENT}%，且小于 100%。</p>}
          {invalid === "turnover" && <p role="alert">成交额倍数须大于 1。</p>}
          <div className={styles.monitorHelp}>
            <p><strong>时间窗口：</strong><span id="alert-window-help">填 30 就看最近 30 秒内的涨跌，并统计这 30 秒的成交额。</span></p>
            <p><strong>上涨幅度：</strong><span id="alert-up-help">勾选并填 5，窗口内涨幅达到 5% 就记一条异动。</span></p>
            <p><strong>下跌幅度：</strong><span id="alert-down-help">勾选并填 5，窗口内跌幅达到 5% 就记一条异动。</span></p>
            <p><strong>告警成交额倍数：</strong><span id="alert-turnover-help">填 3，每轮首次告警要求窗口成交额达到基准的 3 倍。比如监控窗口是 10:00:00 到 10:00:30，取 09:00 到 10:00 的 60 根完整 1 分钟 K 线的成交额中位数，再除以 2，得到 30 秒的基准成交额。</span></p>
          </div>
          {coinCount !== null && <p>可交易币种共 {coinCount} 个</p>}
          <p role="status">
            当前设置 {seconds} 秒 / {[thresholds.up !== null ? `上涨 ${formatPercent.format(thresholds.up)}%` : null, thresholds.down !== null ? `下跌 ${formatPercent.format(thresholds.down)}%` : null].filter(Boolean).join(" / ")} / 成交额 ≥ {turnoverMultiple} 倍 · {enabled
              ? !symbols ? "正在准备监控名单" : !hasSymbols ? "暂无可交易币种"
                : `${online ? "行情已连接" : "正在连接行情"} · 已收到 ${observedCoins} 个币种的行情`
              : "监控已停止"}
          </p>
          {directoryError && <p role="status">合约列表同步失败，正在重试。</p>}
          <div className={styles.monitorHelp}>
            <p><strong>告警怎么升级？</strong> 价格达到涨跌阈值时，先记入<a href="#spike-records">超阈值记录</a>。每轮只有第一次告警要检查成交额。</p>
            <p>例如窗口设为 30 秒、涨幅设为 5%。价格从 100 涨到 108，成交额达标就报 1 级。下一档从 105 算，再涨 5% 到 110.25 就报 2 级。如果一口气涨到 116，可以直接报 3 级。</p>
            <p>每次升级都会重新计时。窗口内没到下一级，就重新找下一轮异动。上涨和下跌分别计级。</p>
          </div>
          <p>监控币种深度调研名单里的全部币安 USDT 本位永续合约。请保持行情页打开，切换币种或交易所时监控会继续运行。</p>
        </section>
        <details className={styles.turnover} open>
          <summary className={styles.monitorSectionSummary}><h4>告警记录 <span>最近 100 条</span></h4></summary>
          <p role="status">{alerts.length ? `最新告警 ${alerts[0].symbol} ${alerts[0].level} 级 · ${formatPercent.format(alerts[0].change)}%` : "暂无告警。"}</p>
          {alerts.length > 0 && <div className={`${styles.tableScroll} ${styles.alertScroll}`}>
            <table className={styles.alertTable}>
              <thead><tr>
                <th scope="col">交易对</th><th scope="col">告警级别</th><th scope="col">触发时间</th><th scope="col">参考价 (USDT)</th>
                <th scope="col">触发价 (USDT)</th><th scope="col">涨跌幅</th><th scope="col">阈值</th><th scope="col">窗口 (秒)</th>
                <th scope="col">窗口成交额 (USDT)</th>
                <th scope="col">币安全体账户多空比</th><th scope="col">OKX 全体账户多空比</th>
                <th scope="col">币安大户多空持仓比</th><th scope="col">OKX 大户账户多空比</th>
              </tr></thead>
              <tbody>
                {alerts.map((alert) => {
                  const context = typeof alert.context === "object" ? alert.context : undefined;
                  const reason = typeof alert.context === "string" ? alertContextMessages[alert.context] : "未取得告警行情";
                  return <tr key={`${alert.symbol}:${alert.time}:${alert.threshold}`}>
                    <th scope="row">{alert.symbol}</th>
                    <td>{alert.level} 级</td>
                    <td><time dateTime={new Date(alert.time).toISOString()}>{formatTime.format(alert.time)}</time></td>
                    <td>{formatPrice.format(alert.previous)}</td>
                    <td>{formatPrice.format(alert.price)}</td>
                    <td className={alert.change < 0 ? styles.sell : styles.buy}>{formatPercent.format(alert.change)}%</td>
                    <td>{formatPercent.format(alert.threshold)}%</td>
                    <td>{alert.seconds}</td>
                    <td>{alert.volume?.turnover != null && alert.volume.multiple != null
                      ? <>{formatTurnover.format(alert.volume.turnover)} <small>{formatTurnover.format(alert.volume.multiple)} 倍</small></>
                      : "沿用首轮核验"}</td>
                    {alert.context === undefined ? <td colSpan={4}>正在补充多空比…</td> : <>
                      <td><Ratio data={context?.binanceAccounts} /></td>
                      <td><OkxRatio result={context?.okxAccounts} reason={reason} /></td>
                      <td><Ratio data={context?.binancePositions} /></td>
                      <td><OkxRatio result={context?.okxTopAccounts} reason={reason} /></td>
                    </>}
                  </tr>;
                })}
              </tbody>
            </table>
          </div>}
          {alerts.length > 0 && <p>多空比使用告警时各平台最近一期 5 分钟统计。币安大户按保证金余额取前 20%，OKX 大户账户按未平仓头寸价值取前 5%。</p>}
        </details>
        <SpikeForecastPanel records={forecasts} />
      </div>
    </details>
  );

  return (
    <>
      <section id="market-alerts" className={styles.monitorPanel} aria-labelledby="market-alert-heading" hidden={showRecords}>
        <h2 id="market-alert-heading" className={styles.sectionTitle}>交易策略</h2>
        <DingTalkSettings {...strategyNotifications} />
        {strategy}
      </section>
      {showRecords && <SpikeRecords records={spikes} />}
    </>
  );
}
