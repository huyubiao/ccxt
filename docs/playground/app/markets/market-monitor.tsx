"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { mergeAlertHistory, readSpikeRecords, retainSpikeRecords, saveSpikeRecords } from "@/lib/alert-history";
import { apiUrl } from "@/lib/basePath";
import { getContractCoins, type MarketInstrument } from "@/lib/market-lookup";
import {
  DEFAULT_ALERT_SECONDS, DEFAULT_TURNOVER_MULTIPLE, MAX_ALERT_PERCENT, MAX_ALERT_SECONDS, MAX_TURNOVER_MULTIPLE,
  MIN_ALERT_PERCENT, MIN_ALERT_SECONDS, MIN_TURNOVER_MULTIPLE,
  clampAlertThreshold, clampTurnoverMultiple, getTurnoverMultiple, parseAlertSeconds,
  recordPriceLevel, restoreAlertSeconds, restoreAlertThreshold, restoreTurnoverMultiple, settlePriceSeries, spikeKey,
  type AlertTurnover, type AlertVolume, type DirectionalThresholds,
  type LeveledPriceState, type PriceAlertLevel, type PriceAlertSeries, type SpikeIdentity, type SpikeRecord,
} from "@/lib/price-alerts";
import { createMarketSpikeEvent } from "@/lib/strategy-notification-events";
import { useBackgroundMonitor } from "./use-background-monitor";
import type { BackgroundRule } from "@/lib/background-monitor-types";
import AlertRecords from "./alert-records";
import { useStrategyNotifications } from "./use-strategy-notifications";
import DingTalkSettings from "./dingtalk-settings";
import BinanceSettings from "./binance-settings";
import TestStrategy from "./test-strategy";
import TradeRecords from "./trade-records";
import { useTrading } from "./use-trading";
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

export default function MarketMonitor({ contracts, coinCount, directoryError }: {
  contracts: readonly MarketInstrument[] | undefined;
  coinCount: number | null;
  directoryError: boolean;
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
  const [spikes, setSpikes] = useState<SpikeRecord[]>([]);
  const [recordsReady, setRecordsReady] = useState(false);
  const background = useBackgroundMonitor();
  const trading = useTrading();
  const server = background.mode === "local";
  const canEdit = background.mode !== "loading" && !background.saving && !background.deleting;
  const serverRule = background.data?.configured ? background.data.rule : null;
  const strategyNotifications = useStrategyNotifications();
  const { config: dingTalkConfig, configMessage: dingTalkConfigMessage, notifyStrategy } = strategyNotifications;
  const [observedSymbols, setObservedSymbols] = useState<ReadonlySet<string>>(() => new Set());
  const [online, setOnline] = useState(false);
  const [dingTalkEnabled, setDingTalkEnabled] = useState(false);
  const notifyDingTalk = useRef(false);
  const activeRule = useRef<DirectionalThresholds & { seconds: number; turnoverMultiple: number }>({
    ...DEFAULT_THRESHOLDS, seconds: DEFAULT_ALERT_SECONDS, turnoverMultiple: DEFAULT_TURNOVER_MULTIPLE,
  });
  const symbols = useMemo(() => background.mode === "browser" && enabled && contracts ? new Set(contracts.map(({ id }) => id)) : null,
    [background.mode, enabled, contracts]);
  const activeSymbols = useRef(symbols);
  const hasSymbols = !!symbols?.size;
  const observedCoins = contracts ? getContractCoins(contracts, observedSymbols).size : 0;
  const strategyEnabled = server ? background.data?.rule.enabled === true : background.mode === "browser" && enabled;
  const strategyNotify = server && serverRule ? serverRule.notify : dingTalkEnabled;
  const displayedThresholds = serverRule ?? thresholds;
  const displayedSeconds = serverRule?.seconds ?? seconds;
  const displayedMultiple = serverRule?.turnoverMultiple ?? turnoverMultiple;
  const serverSpikes = background.data?.spikes;
  const serverRecords = background.data?.records;
  const history = useMemo(() => mergeAlertHistory(spikes, serverSpikes, serverRecords), [spikes, serverSpikes, serverRecords]);

  const storedUp = serverRule?.up;
  const storedDown = serverRule?.down;
  const storedSeconds = serverRule?.seconds;
  const storedMultiple = serverRule?.turnoverMultiple;
  useEffect(() => {
    if (storedUp === undefined || storedDown === undefined || storedSeconds === undefined || storedMultiple === undefined) return;
    setUpSelected(storedUp !== null);
    setDownSelected(storedDown !== null);
    if (storedUp !== null) setUpInput(String(storedUp));
    if (storedDown !== null) setDownInput(String(-storedDown));
    setSecondsInput(String(storedSeconds));
    setTurnoverInput(String(storedMultiple));
  }, [storedUp, storedDown, storedSeconds, storedMultiple]);

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
      const savedMultiple = restoreTurnoverMultiple(localStorage.getItem(TURNOVER_STORAGE_KEY) ?? "");
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
    async function fetchTurnover(record: SpikeRecord, signal: AbortSignal): Promise<AlertTurnover> {
      const params = new URLSearchParams({
        symbol: record.symbol, seconds: String(record.seconds), time: String(record.time), view: "turnover",
      });
      const response = await fetch(apiUrl(`/api/markets/alert-context?${params}`), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
      });
      if (!response.ok) throw new Error("Alert data unavailable.");
      return response.json();
    }

    function addSpikeRecords(batch: SpikeRecord[]) {
      setSpikes((current) => retainSpikeRecords([...batch, ...current]));
    }

    function confirmAlert(record: SpikeRecord & { volume: AlertVolume }, latestPrice?: number) {
      if (!activeSymbols.current?.has(record.symbol)) return;
      const event = createMarketSpikeEvent(record, record.volume, latestPrice);
      if (notifyDingTalk.current) notifyStrategy(event);
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
      const data = await fetchTurnover(record, signal).catch(() => null);
      if (lifecycle.signal.aborted || signal.aborted) return;
      syncRule();
      if (signal.aborted) return;
      const direction = record.threshold > 0 ? "up" : "down";
      if (!activeSymbols.current?.has(record.symbol) || samples.get(record.symbol)?.[direction] !== state) {
        settlePriceSeries(state, series, null);
        setSpikes((current) => current.map((row) => row === record ? { ...row, status: "interrupted" } : row));
        return;
      }
      const multiple = data ? getTurnoverMultiple(data) : null;
      const volume = data ? { ...data, multiple } : undefined;
      const passed = volume && multiple !== null && multiple >= record.requiredMultiple;
      const latest = settlePriceSeries(state, series, passed ? volume : null);
      const upgraded = latest !== null && latest.level > record.level;
      const result: SpikeRecord = {
        ...record,
        status: latest ? upgraded ? "upgraded" : "alerted" : multiple === null ? "unavailable" : "below-threshold",
        volume,
      };
      if (latest && volume) {
        const details = upgraded ? levelRecord(record.symbol, latest, record.threshold, record.seconds) : record;
        const alert = { ...details, status: "alerted" as const, requiredMultiple: upgraded ? null : record.requiredMultiple, volume };
        confirmAlert(alert, state.samples.at(-1)?.price);
        if (upgraded) addSpikeRecords([alert]);
      }
      setSpikes((current) => current.map((row) => row === record ? result : row));
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
            const record = { ...details, requiredMultiple: null, status: "alerted" as const, volume: result.volume };
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
          settlePriceSeries(job.state, job.series, null);
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
    };
  }, [hasSymbols, notifyStrategy]);

  async function deleteAlertRecords(records: readonly SpikeIdentity[]) {
    if (server) await background.deleteSpikes(records);
    const deleted = new Set(records.map(spikeKey));
    setSpikes((current) => current.filter((row) => !deleted.has(spikeKey(row))));
  }

  function toggleDingTalkNotifications() {
    const next = !strategyNotify;
    if (next && dingTalkConfig !== "ready") {
      const settings = document.getElementById("account-settings");
      if (settings instanceof HTMLDetailsElement) settings.open = true;
      document.getElementById("dingtalk-heading")?.focus();
      return;
    }
    if (server) {
      saveServerRule({ notify: next });
      return;
    }
    notifyDingTalk.current = next;
    setDingTalkEnabled(next);
    try { localStorage.setItem(DINGTALK_NOTIFICATION_STORAGE_KEY, String(next)); } catch { /* Keep the session setting. */ }
  }

  function toggleMonitoring(next: boolean) {
    if (!canEdit || next === strategyEnabled) return;
    const message = next
      ? server
        ? "确定启用异动监控策略？启用后将按当前规则监控行情，关闭网页后仍会继续。"
        : "确定启用异动监控策略？启用后将按当前规则监控行情，请保持网页打开。"
      : "确定关闭异动监控策略？价格监控和待核验告警会停止，已有仓位会保留。";
    if (!window.confirm(message)) return;
    if (server) {
      saveServerRule({ enabled: next });
      return;
    }
    if (!next) {
      activeSymbols.current = null;
    }
    setEnabled(next);
    try {
      localStorage.setItem(ENABLED_STORAGE_KEY, String(next));
    } catch {
      // The current session still uses the switch state.
    }
  }

  function saveServerRule(change: Partial<BackgroundRule>) {
    const rule = serverRule ?? { ...activeRule.current, enabled: strategyEnabled, notify: strategyNotify };
    void background.save({ ...rule, ...change });
  }

  function normalizeThreshold(direction: keyof DirectionalThresholds) {
    const [value, setInput] = direction === "up" ? [upInput, setUpInput] : [downInput, setDownInput];
    const threshold = clampAlertThreshold(value, direction);
    if (threshold !== null) {
      setInput(String(Math.abs(threshold)));
      setInvalid((current) => current === direction ? null : current);
    }
    return threshold;
  }

  function normalizeTurnoverInput() {
    const multiple = clampTurnoverMultiple(turnoverInput);
    if (multiple !== null) {
      setTurnoverInput(String(multiple));
      setInvalid((current) => current === "turnover" ? null : current);
    }
    return multiple;
  }

  function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const up = upSelected ? normalizeThreshold("up") : null;
    const down = downSelected ? normalizeThreshold("down") : null;
    const nextSeconds = parseAlertSeconds(secondsInput);
    const nextMultiple = normalizeTurnoverInput();
    const error = nextSeconds === null ? "seconds" : !upSelected && !downSelected ? "directions"
      : upSelected && up === null ? "up"
      : downSelected && down === null ? "down"
      : nextMultiple === null ? "turnover" : null;
    setInvalid(error);
    if (error || nextSeconds === null || nextMultiple === null) return;
    const next: DirectionalThresholds = { up, down };
    if (server) {
      saveServerRule({ ...next, seconds: nextSeconds, turnoverMultiple: nextMultiple });
      return;
    }
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

  const worker = background.data?.worker;
  const monitoringStatus = background.mode === "loading" ? "正在读取监控状态"
    : !strategyEnabled ? "监控已停止"
    : server ? worker === "connected" ? "行情已连接 · 关闭网页后继续"
      : worker === "offline" ? "监控进程离线，正在重试" : "正在连接行情"
    : !symbols ? "正在准备监控名单" : !hasSymbols ? "暂无可交易币种"
      : `${online ? "行情已连接" : "正在连接行情"} · 已收到 ${observedCoins} 个币种的行情`;

  const strategy = (
    <details className={styles.monitorFeature}>
      <summary className={styles.monitorSummary}>
        <h3>异动监控策略 <small>{monitoringStatus}</small></h3>
      </summary>
      <div className={styles.monitorBody}>
        <div className={styles.monitorHeading}>
          <label className={styles.monitorSwitch}>
            <input type="checkbox" role="switch" checked={strategyEnabled} disabled={!canEdit}
              onChange={(event) => toggleMonitoring(event.target.checked)} />
            启用策略
          </label>
          {background.saving && <span role="status">正在保存策略…</span>}
        </div>
        {background.error && <p role="alert">{background.error}</p>}
        <section className={`${styles.result} ${styles.monitorSettings}`} aria-label="告警设置">
          <form className={styles.monitorForm} onSubmit={saveSettings}>
            <label htmlFor="alert-seconds">时间窗口（{MIN_ALERT_SECONDS}–{MAX_ALERT_SECONDS} 秒）</label>
            <input id="alert-seconds" inputMode="numeric" value={secondsInput} onChange={(event) => setSecondsInput(event.target.value)}
              aria-invalid={invalid === "seconds"} aria-describedby="alert-window-help" placeholder={String(DEFAULT_ALERT_SECONDS)} />
            <label className={styles.monitorSwitch}>
              <input type="checkbox" checked={upSelected} onChange={(event) => setUpSelected(event.target.checked)} aria-describedby="alert-up-help" />
              上涨幅度（{MIN_ALERT_PERCENT}%–{MAX_ALERT_PERCENT}%）
            </label>
            <input aria-label="上涨阈值" value={upInput} disabled={!upSelected} onChange={(event) => setUpInput(event.target.value)}
              onBlur={() => normalizeThreshold("up")}
              aria-invalid={invalid === "up"} aria-describedby="alert-up-help" placeholder="5" />
            <label className={styles.monitorSwitch}>
              <input type="checkbox" checked={downSelected} onChange={(event) => setDownSelected(event.target.checked)} aria-describedby="alert-down-help" />
              下跌幅度（{MIN_ALERT_PERCENT}%–{MAX_ALERT_PERCENT}%）
            </label>
            <input aria-label="下跌阈值" value={downInput} disabled={!downSelected} onChange={(event) => setDownInput(event.target.value)}
              onBlur={() => normalizeThreshold("down")}
              aria-invalid={invalid === "down"} aria-describedby="alert-down-help" placeholder="5" />
            <label htmlFor="alert-turnover-multiple">告警成交额倍数（{MIN_TURNOVER_MULTIPLE}–{MAX_TURNOVER_MULTIPLE} 倍）</label>
            <input id="alert-turnover-multiple" inputMode="decimal" value={turnoverInput} onChange={(event) => setTurnoverInput(event.target.value)}
              onBlur={normalizeTurnoverInput}
              aria-invalid={invalid === "turnover"} aria-describedby="alert-turnover-help alert-turnover-baseline" />
            <button type="submit" disabled={!canEdit}>保存设置</button>
            <button type="button" disabled={!canEdit || (!strategyNotify && dingTalkConfig === "checking")}
              aria-describedby="market-spike-dingtalk-status" onClick={toggleDingTalkNotifications}>
              {strategyNotify ? "停止钉钉通知" : "开启钉钉通知"}
            </button>
          </form>
          <p id="market-spike-dingtalk-status" role="status">
            异动监控策略的钉钉通知{strategyNotify ? "已开启" : "已关闭"}。
            {dingTalkConfig === "ready" ? (strategyNotify ? "确认的告警将推送到钉钉群机器人。" : "")
              : dingTalkConfig === "checking" ? dingTalkConfigMessage
                : `${dingTalkConfigMessage}。请到「钉钉推送」查看。`}
          </p>
          {invalid === "seconds" && <p role="alert">请输入 {MIN_ALERT_SECONDS} 至 {MAX_ALERT_SECONDS} 之间的整数秒数。</p>}
          {invalid === "directions" && <p role="alert">请至少勾选上涨幅度或下跌幅度。</p>}
          {invalid === "up" && <p role="alert">请输入有效的上涨幅度。</p>}
          {invalid === "down" && <p role="alert">请输入有效的下跌幅度。</p>}
          {invalid === "turnover" && <p role="alert">请输入有效的成交额倍数。</p>}
          <div className={styles.monitorHelp}>
            <p><strong>时间窗口：</strong><span id="alert-window-help">填 30 就看最近 30 秒内的涨跌，并统计这 30 秒的成交额。</span></p>
            <p><strong>上涨幅度：</strong><span id="alert-up-help">勾选并填 5，窗口内涨幅达到 5% 就记一条异动。</span></p>
            <p><strong>下跌幅度：</strong><span id="alert-down-help">勾选并填 5，窗口内跌幅达到 5% 就记一条异动。</span></p>
            <p><strong>告警成交额倍数：</strong><span id="alert-turnover-help">填 3，每轮首次告警要求窗口成交额达到基准的 3 倍。比如监控窗口是 10:00:00 到 10:00:30，取 09:00 到 10:00 的 60 根完整 1 分钟 K 线的成交额中位数，再除以 2，得到 30 秒的基准成交额。</span></p>
          </div>
          {coinCount !== null && <p>可交易币种共 {coinCount} 个</p>}
          <p role="status">
            当前设置 {displayedSeconds} 秒 / {[
              displayedThresholds.up !== null ? `上涨 ${formatPercent.format(displayedThresholds.up)}%` : null,
              displayedThresholds.down !== null ? `下跌 ${formatPercent.format(displayedThresholds.down)}%` : null,
            ].filter(Boolean).join(" / ")} / 成交额 ≥ {displayedMultiple} 倍 · {monitoringStatus}
          </p>
          {directoryError && <p role="status">合约列表同步失败，正在重试。</p>}
          <div className={styles.monitorHelp}>
            <p><strong>告警怎么升级？</strong> 价格达到涨跌阈值时，先记入告警记录。每轮只有第一次告警要检查成交额。</p>
            <p>例如窗口设为 30 秒、涨幅设为 5%。价格从 100 涨到 108，成交额达标就报 1 级。下一档从 105 算，再涨 5% 到 110.25 就报 2 级。如果一口气涨到 116，可以直接报 3 级。</p>
            <p>每次升级都会重新计时。窗口内没到下一级，就重新找下一轮异动。上涨和下跌分别计级。</p>
          </div>
          <p>监控币种深度调研名单里的全部币安 USDT 本位永续合约。{server
            ? "启用后自动启动独立进程，关闭网页后继续监控。"
            : background.mode === "browser" ? "请保持行情页打开。" : ""}</p>
        </section>
        <AlertRecords records={history} canDelete={recordsReady && canEdit} onDelete={deleteAlertRecords} />
      </div>
    </details>
  );

  return (
    <section id="market-alerts" className={styles.monitorPanel} aria-labelledby="market-alert-heading">
      <h2 id="market-alert-heading" className={styles.sectionTitle}>交易策略</h2>
      <details id="account-settings" className={styles.monitorFeature}>
        <summary className={styles.monitorSummary}><h3>账号设置</h3></summary>
        <div className={`${styles.monitorBody} ${styles.accountSettingsGrid}`}>
          <DingTalkSettings {...strategyNotifications} />
          <BinanceSettings availability={trading.mode} status={trading.data} error={trading.error} onChange={trading.changeAccount} />
        </div>
      </details>
      {strategy}
      <TestStrategy mode={trading.mode} status={trading.data} error={trading.error} onSubmit={trading.placeTestOrder} />
      <TradeRecords trades={trading.data?.trades ?? []} activeMode={trading.data?.enabled ? trading.data.mode : "off"}
        onClose={trading.closeTrade} />
    </section>
  );
}
