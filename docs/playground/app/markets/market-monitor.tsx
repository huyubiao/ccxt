"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { mergeAlertHistory, readSpikeRecords, retainSpikeRecords, saveSpikeRecords } from "@/lib/alert-history";
import { apiUrl } from "@/lib/basePath";
import { getContractCoins, type MarketInstrument } from "@/lib/market-lookup";
import {
  DEFAULT_ALERT_OBSERVATION, DEFAULT_ALERT_SECONDS, DEFAULT_TURNOVER_MULTIPLE, MAX_ALERT_PERCENT, MAX_ALERT_SECONDS, MAX_TURNOVER_MULTIPLE,
  MIN_ALERT_PERCENT, MIN_ALERT_SECONDS, MIN_TURNOVER_MULTIPLE,
  clampAlertThreshold, clampTurnoverMultiple, getTurnoverMultiple, parseAlertObservation, parseAlertSeconds,
  recordPriceLevel, restoreAlertSeconds, restoreAlertThreshold, restoreTurnoverMultiple, settlePriceAlert, spikeKey,
  type AlertObservationRule, type AlertTurnover, type AlertVolume, type DirectionalThresholds,
  type LeveledPriceState, type PendingPriceAlert, type PriceAlertLevel, type SpikeIdentity, type SpikeRecord,
} from "@/lib/price-alerts";
import { createMarketSpikeEvent } from "@/lib/strategy-notification-events";
import { useBackgroundMonitor } from "./use-background-monitor";
import { defaultContinuationRule, type BackgroundRule } from "@/lib/background-monitor-types";
import { tradingModeLabels } from "@/lib/trading-types";
import AlertRecords from "./alert-records";
import { useStrategyNotifications } from "./use-strategy-notifications";
import DingTalkSettings from "./dingtalk-settings";
import BinanceSettings from "./binance-settings";
import TestStrategy from "./test-strategy";
import TradeRecords from "./trade-records";
import StrategyRuntimeStatus from "./strategy-runtime-status";
import { useMarketServiceHealth } from "./use-market-service-health";
import { useRememberedDetails } from "./use-remembered-details";
import { useTrading } from "./use-trading";
import styles from "./markets.module.css";

const STREAM = "wss://fstream.binance.com/market/ws/!miniTicker@arr";
const STORAGE_KEY = "ccxt-market-alert-threshold";
const WINDOW_STORAGE_KEY = "ccxt-market-alert-seconds";
const ENABLED_STORAGE_KEY = "ccxt-market-alert-enabled";
const DINGTALK_NOTIFICATION_STORAGE_KEY = "ccxt-market-alert-dingtalk-notifications";
const DIRECTION_STORAGE_KEY = "ccxt-market-alert-directions";
const TURNOVER_STORAGE_KEY = "ccxt-market-alert-turnover-multiple";
const OBSERVATION_STORAGE_KEY = "ccxt-market-alert-observation";
const QUEUE_LIMIT = 100;
const TURNOVER_CONCURRENCY = 2;
const DEFAULT_THRESHOLDS: DirectionalThresholds = { up: 5, down: -5 };
const formatPercent = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4, signDisplay: "exceptZero" });

type TurnoverJob = {
  record: SpikeRecord & { requiredMultiple: number };
  state: LeveledPriceState;
  pending: PendingPriceAlert;
};
type Tick = { e: string; s: string; E: number; c: string; st?: number };

function levelRecord(symbol: string, move: PriceAlertLevel, seconds: number) {
  return {
    symbol, time: move.sample.sampledAt ?? move.sample.time, price: move.sample.price, previous: move.previous,
    originalReference: move.originalReference, observationMinutes: move.observationMinutes,
    change: move.change, threshold: move.threshold, seconds, level: move.level,
  };
}

function observationInputs(rule: AlertObservationRule) {
  return { minutes: String(rule.minutes), upPercent: String(rule.upPercent), downPercent: String(rule.downPercent) };
}

export default function MarketMonitor({ contracts, coinCount, directoryError }: {
  contracts: readonly MarketInstrument[] | undefined;
  coinCount: number | null;
  directoryError: boolean;
}) {
  const strategyDetails = useRememberedDetails("market-spike");
  const accountDetails = useRememberedDetails("account-settings");
  const [enabled, setEnabled] = useState(false);
  const [upInput, setUpInput] = useState("5");
  const [downInput, setDownInput] = useState("5");
  const [upSelected, setUpSelected] = useState(true);
  const [downSelected, setDownSelected] = useState(true);
  const [secondsInput, setSecondsInput] = useState(String(DEFAULT_ALERT_SECONDS));
  const [thresholds, setThresholds] = useState(DEFAULT_THRESHOLDS);
  const [seconds, setSeconds] = useState(DEFAULT_ALERT_SECONDS);
  const [turnoverInput, setTurnoverInput] = useState(String(DEFAULT_TURNOVER_MULTIPLE));
  const [turnoverMultiple, setTurnoverMultiple] = useState(DEFAULT_TURNOVER_MULTIPLE);
  const [observation, setObservation] = useState(DEFAULT_ALERT_OBSERVATION);
  const [observationInput, setObservationInput] = useState(() => observationInputs(DEFAULT_ALERT_OBSERVATION));
  const [lookbackInput, setLookbackInput] = useState(String(defaultContinuationRule.lookbackHours));
  const [spikeStopInput, setSpikeStopInput] = useState(String(defaultContinuationRule.stopLossPercent));
  const [spikeTakeInput, setSpikeTakeInput] = useState(String(defaultContinuationRule.takeProfitPercent));
  const [invalid, setInvalid] = useState<"up" | "down" | "directions" | "seconds" | "turnover" | "observation" | null>(null);
  const [spikes, setSpikes] = useState<SpikeRecord[]>([]);
  const [recordsReady, setRecordsReady] = useState(false);
  const background = useBackgroundMonitor();
  const trading = useTrading();
  const health = useMarketServiceHealth();
  const server = background.mode === "local";
  const canEdit = background.mode !== "loading" && !background.saving && !background.deleting;
  const serverRule = background.data?.configured ? background.data.rule : null;
  const strategyNotifications = useStrategyNotifications();
  const { config: dingTalkConfig, configMessage: dingTalkConfigMessage, notifyStrategy } = strategyNotifications;
  const [observedSymbols, setObservedSymbols] = useState<ReadonlySet<string>>(() => new Set());
  const [online, setOnline] = useState(false);
  const [dingTalkEnabled, setDingTalkEnabled] = useState(false);
  const notifyDingTalk = useRef(false);
  const activeRule = useRef<DirectionalThresholds & { seconds: number; turnoverMultiple: number; observation: AlertObservationRule }>({
    ...DEFAULT_THRESHOLDS, seconds: DEFAULT_ALERT_SECONDS, turnoverMultiple: DEFAULT_TURNOVER_MULTIPLE,
    observation: DEFAULT_ALERT_OBSERVATION,
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
  const displayedObservation = serverRule ? serverRule.observation ?? DEFAULT_ALERT_OBSERVATION : observation;
  const storedContinuation = serverRule?.continuation ?? defaultContinuationRule;
  const continuation = {
    ...storedContinuation,
    stopLossPercent: storedContinuation.stopLossPercent ?? defaultContinuationRule.stopLossPercent,
    takeProfitPercent: storedContinuation.takeProfitPercent ?? defaultContinuationRule.takeProfitPercent,
  };
  const tradingMode = trading.data?.mode ?? "off";
  const serverSpikes = background.data?.spikes;
  const serverRecords = background.data?.records;
  const history = useMemo(() => mergeAlertHistory(spikes, serverSpikes, serverRecords), [spikes, serverSpikes, serverRecords]);

  const storedUp = serverRule?.up;
  const storedDown = serverRule?.down;
  const storedSeconds = serverRule?.seconds;
  const storedMultiple = serverRule?.turnoverMultiple;
  const storedMinutes = serverRule?.observation?.minutes;
  const storedObservationUp = serverRule?.observation?.upPercent;
  const storedObservationDown = serverRule?.observation?.downPercent;
  useEffect(() => {
    if (storedUp === undefined || storedDown === undefined || storedSeconds === undefined || storedMultiple === undefined) return;
    setUpSelected(storedUp !== null);
    setDownSelected(storedDown !== null);
    if (storedUp !== null) setUpInput(String(storedUp));
    if (storedDown !== null) setDownInput(String(-storedDown));
    setSecondsInput(String(storedSeconds));
    setTurnoverInput(String(storedMultiple));
  }, [storedUp, storedDown, storedSeconds, storedMultiple]);

  useEffect(() => {
    const rule = parseAlertObservation(storedMinutes, storedObservationUp, storedObservationDown);
    if (rule) setObservationInput(observationInputs(rule));
  }, [storedMinutes, storedObservationUp, storedObservationDown]);

  useEffect(() => {
    setLookbackInput(String(continuation.lookbackHours));
    setSpikeStopInput(String(continuation.stopLossPercent));
    setSpikeTakeInput(String(continuation.takeProfitPercent));
  }, [continuation.lookbackHours,
    continuation.stopLossPercent, continuation.takeProfitPercent]);

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
      const savedObservation = JSON.parse(localStorage.getItem(OBSERVATION_STORAGE_KEY) ?? "null");
      const observation = parseAlertObservation(savedObservation?.minutes, savedObservation?.upPercent, savedObservation?.downPercent);
      if (observation) {
        activeRule.current.observation = observation;
        setObservation(observation);
        setObservationInput(observationInputs(observation));
      }
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
    const samples = new Map<string, LeveledPriceState>();
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

    function confirmAlert(record: SpikeRecord & { volume: AlertVolume }) {
      if (!activeSymbols.current?.has(record.symbol)) return;
      const event = createMarketSpikeEvent(record, record.volume);
      if (notifyDingTalk.current) notifyStrategy(event);
    }

    function resetPriceMonitoring(keepSeries = false) {
      for (const [symbol, state] of samples) {
        if (!keepSeries || !state.series) samples.delete(symbol);
      }
      pendingTurnover.length = 0;
      turnoverScope.abort();
      turnoverScope = new AbortController();
      setSpikes((current) => current.map((row) => row.status === "pending" ? { ...row, status: "interrupted" } : row));
    }

    function syncRule() {
      const rule = activeRule.current;
      if (sampledRule.seconds !== rule.seconds || sampledRule.up !== rule.up || sampledRule.down !== rule.down ||
          sampledRule.turnoverMultiple !== rule.turnoverMultiple || sampledRule.observation.minutes !== rule.observation.minutes ||
          sampledRule.observation.upPercent !== rule.observation.upPercent || sampledRule.observation.downPercent !== rule.observation.downPercent) {
        resetPriceMonitoring();
      }
      sampledRule = rule;
      return rule;
    }

    async function checkTurnover({ record, state, pending }: TurnoverJob) {
      const isCurrent = () => activeSymbols.current?.has(record.symbol) &&
        samples.get(record.symbol) === state && state.pending === pending;
      const interrupt = () => setSpikes((current) => current.map((row) => row === record ? { ...row, status: "interrupted" } : row));
      if (!isCurrent()) {
        interrupt();
        return;
      }
      const signal = turnoverScope.signal;
      const data = await fetchTurnover(record, signal).catch(() => null);
      if (lifecycle.signal.aborted || signal.aborted) return;
      syncRule();
      if (signal.aborted) return;
      if (!isCurrent()) {
        interrupt();
        return;
      }
      const multiple = data ? getTurnoverMultiple(data) : null;
      const volume = data ? { ...data, multiple } : undefined;
      const confirmedVolume = volume && multiple !== null && multiple >= record.requiredMultiple ? volume : null;
      const result: SpikeRecord = {
        ...record,
        status: confirmedVolume ? "alerted" : multiple === null ? "unavailable" : "below-threshold",
        volume,
      };
      setSpikes((current) => current.map((row) => row === record ? result : row));
      settlePriceAlert(state, pending, confirmedVolume ? { volume: confirmedVolume, confirmedAt: Date.now() } : null);
      if (confirmedVolume) confirmAlert({ ...result, volume: confirmedVolume });
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
      for (const symbol of samples.keys()) {
        if (!sampledSymbols?.has(symbol)) samples.delete(symbol);
      }
      for (const symbol of latestPrices.keys()) {
        if (!sampledSymbols?.has(symbol)) {
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
        const state = samples.get(symbol) ?? { samples: [] };
        samples.set(symbol, state);
        const result = recordPriceLevel(state, { time, price, sampledAt }, rule, seconds, rule.observation);
        if (!result) continue;
        const details = levelRecord(symbol, result.move, seconds);
        if (result.needsTurnover) {
          const record = { ...details, requiredMultiple: rule.turnoverMultiple, status: "pending" as const };
          batch.push(record);
          pendingTurnover.push({ record, state, pending: result.pending });
        } else {
          const record = { ...details, requiredMultiple: null, status: "alerted" as const, volume: result.volume };
          batch.push(record);
          confirmAlert(record);
        }
      }
      if (!batch.length) return;
      addSpikeRecords(batch);
      if (pendingTurnover.length > QUEUE_LIMIT) {
        const dropped = new Set<SpikeRecord>();
        for (const job of pendingTurnover.splice(0, pendingTurnover.length - QUEUE_LIMIT)) {
          settlePriceAlert(job.state, job.pending, null);
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
        resetPriceMonitoring(true);
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
    const rule = serverRule ?? {
      ...activeRule.current, enabled: strategyEnabled, notify: strategyNotify,
    };
    void background.save({ ...rule, observation: rule.observation ?? DEFAULT_ALERT_OBSERVATION, continuation, ...change,
      accountRevision: trading.data?.accountRevision });
  }

  function saveContinuation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const stopInput = spikeStopInput || String(defaultContinuationRule.stopLossPercent);
    const takeInput = spikeTakeInput || String(defaultContinuationRule.takeProfitPercent);
    setSpikeStopInput(stopInput);
    setSpikeTakeInput(takeInput);
    saveServerRule({ continuation: {
      ...continuation, lookbackHours: Number(lookbackInput),
      stopLossPercent: Number(stopInput), takeProfitPercent: Number(takeInput),
    } });
  }

  function toggleAutoTrade(autoTrade: boolean) {
    if (autoTrade && !trading.data?.enabled) return;
    saveServerRule({ continuation: { ...continuation, autoTrade } });
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
    const nextObservation = parseAlertObservation(observationInput.minutes, observationInput.upPercent, observationInput.downPercent);
    const error = nextSeconds === null ? "seconds" : !upSelected && !downSelected ? "directions"
      : upSelected && up === null ? "up"
      : downSelected && down === null ? "down"
      : nextMultiple === null ? "turnover" : nextObservation === null ? "observation" : null;
    setInvalid(error);
    if (error || nextSeconds === null || nextMultiple === null || nextObservation === null) return;
    const next: DirectionalThresholds = { up, down };
    if (server) {
      saveServerRule({ ...next, seconds: nextSeconds, turnoverMultiple: nextMultiple, observation: nextObservation });
      return;
    }
    activeRule.current = { ...next, seconds: nextSeconds, turnoverMultiple: nextMultiple, observation: nextObservation };
    setThresholds(next);
    setSeconds(nextSeconds);
    setTurnoverMultiple(nextMultiple);
    setObservation(nextObservation);
    setObservationInput(observationInputs(nextObservation));
    try {
      localStorage.setItem(DIRECTION_STORAGE_KEY, JSON.stringify(next));
      localStorage.setItem(WINDOW_STORAGE_KEY, String(nextSeconds));
      localStorage.setItem(TURNOVER_STORAGE_KEY, String(nextMultiple));
      localStorage.setItem(OBSERVATION_STORAGE_KEY, JSON.stringify(nextObservation));
    } catch {
      // The current session still uses the new threshold.
    }
  }

  const worker = background.data?.worker;
  const monitoringStatus = background.mode !== "browser" && (health.state === "unavailable" || background.readError)
    ? "无法确认监控状态" : background.mode === "loading" ? "正在读取监控状态"
    : !strategyEnabled ? "监控已停止"
    : server ? worker === "connected" ? "行情已连接 · 关闭网页后继续"
      : worker === "offline" ? "监控进程离线，正在重试" : "正在连接行情"
    : !symbols ? "正在准备监控名单" : !hasSymbols ? "暂无可交易币种"
      : `${online ? "行情已连接" : "正在连接行情"} · 已收到 ${observedCoins} 个币种的行情`;

  const strategy = (
    <details className={styles.monitorFeature} {...strategyDetails}>
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
            <label htmlFor="alert-seconds">首次触发窗口（{MIN_ALERT_SECONDS}–{MAX_ALERT_SECONDS} 秒）</label>
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
            <label htmlFor="alert-observation-minutes">观察期窗口（分钟）</label>
            <input id="alert-observation-minutes" inputMode="numeric" value={observationInput.minutes}
              onChange={(event) => setObservationInput({ ...observationInput, minutes: event.target.value })}
              aria-invalid={invalid === "observation"} aria-describedby="alert-observation-help" />
            <label htmlFor="alert-observation-up">观察期上涨幅度（%）</label>
            <input id="alert-observation-up" inputMode="decimal" value={observationInput.upPercent}
              onChange={(event) => setObservationInput({ ...observationInput, upPercent: event.target.value })}
              aria-invalid={invalid === "observation"} aria-describedby="alert-observation-help" />
            <label htmlFor="alert-observation-down">观察期下跌幅度（%）</label>
            <input id="alert-observation-down" inputMode="decimal" value={observationInput.downPercent}
              onChange={(event) => setObservationInput({ ...observationInput, downPercent: event.target.value })}
              aria-invalid={invalid === "observation"} aria-describedby="alert-observation-help" />
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
          {invalid === "observation" && <p role="alert">观察期请填写正整数分钟，涨跌幅请填写大于 0% 且不超过 100% 的数值。</p>}
          <div className={styles.monitorHelp}>
            <p><strong>首次触发窗口</strong> <span id="alert-window-help">填 30 就看最近 30 秒内的涨跌，并统计这 30 秒的成交额。</span></p>
            <p><strong>升级观察</strong> <span id="alert-observation-help">从首次告警确认时开始计时，只沿首次告警方向升级。每次升级重新计时，到期或回到、越过原始参考价时结束本轮。</span></p>
            <p><strong>上涨幅度：</strong><span id="alert-up-help">勾选并填 5，窗口内涨幅达到 5% 就记一条异动。</span></p>
            <p><strong>下跌幅度：</strong><span id="alert-down-help">勾选并填 5，窗口内跌幅达到 5% 就记一条异动。</span></p>
            <p><strong>告警成交额倍数：</strong><span id="alert-turnover-help">填 3，每轮首次告警要求窗口成交额达到基准的 3 倍。比如监控窗口是 10:00:00 到 10:00:30，取 09:00 到 10:00 的 60 根完整 1 分钟 K 线的成交额中位数，再除以 2，得到 30 秒的基准成交额。</span></p>
          </div>
          {coinCount !== null && <p>可交易币种共 {coinCount} 个</p>}
          <p role="status">
            当前设置 {displayedSeconds} 秒 / {[
              displayedThresholds.up !== null ? `上涨 ${formatPercent.format(displayedThresholds.up)}%` : null,
              displayedThresholds.down !== null ? `下跌 ${formatPercent.format(displayedThresholds.down)}%` : null,
            ].filter(Boolean).join(" / ")} / 观察 {displayedObservation.minutes} 分钟
            {" / 观察期上涨幅度 "}{formatPercent.format(displayedObservation.upPercent)}%
            {" / 观察期下跌幅度 "}{formatPercent.format(-displayedObservation.downPercent)}%
            {" / "}成交额 ≥ {displayedMultiple} 倍 · {monitoringStatus}
          </p>
          {directoryError && <p role="status">合约列表同步失败，正在重试。</p>}
          <div className={styles.monitorHelp}>
            <p><strong>告警升级：</strong> 例如原始参考价为 100，首次涨到 105 且成交额达标，确认 1 级告警。观察期涨幅为 3% 时，之后达到 106.09、109.2727 时依次升级告警。告警升级后，观察期时间重新计算。</p>
          </div>
          <p>监控币种深度调研名单里的全部币安 USDT 本位永续合约。{server
            ? "启用状态保存在本地后台，关闭网页后继续监控。要停止监控，可重新打开本页关闭策略。"
            : background.mode === "browser" ? "请保持行情页打开。" : ""}</p>
        </section>
        <section className={`${styles.result} ${styles.monitorSettings}`} aria-labelledby="spike-continuation-heading">
          <div className={styles.monitorHeading}>
            <h4 id="spike-continuation-heading">自动下单</h4>
            {server && <label className={styles.monitorSwitch}>
              <input type="checkbox" role="switch" checked={continuation.autoTrade}
                disabled={!canEdit || (!continuation.autoTrade && !trading.data?.enabled)}
                onChange={(event) => toggleAutoTrade(event.target.checked)} />
              自动下单{trading.data?.enabled ? `（${tradingModeLabels[tradingMode]}）` : ""}
            </label>}
          </div>
          {server && <form className={styles.monitorForm} onSubmit={saveContinuation}>
            <label htmlFor="spike-lookback-hours">异动前回看窗口（小时）</label>
            <input id="spike-lookback-hours" type="number" min={1} max={4_294_967_295} step={1} required value={lookbackInput}
              onChange={(event) => setLookbackInput(event.target.value)} />
            <label htmlFor="spike-stop-loss">新开仓止损（%）</label>
            <input id="spike-stop-loss" type="number" min={0.1} max={20} step="any" value={spikeStopInput}
              onChange={(event) => setSpikeStopInput(event.target.value)}
              onBlur={({ currentTarget }) => {
                if (currentTarget.value === "" && !currentTarget.validity.badInput) {
                  setSpikeStopInput(String(defaultContinuationRule.stopLossPercent));
                }
              }} />
            <label htmlFor="spike-take-profit">新开仓止盈（%）</label>
            <input id="spike-take-profit" type="number" min={0.1} max={50} step="any" value={spikeTakeInput}
              onChange={(event) => setSpikeTakeInput(event.target.value)}
              onBlur={({ currentTarget }) => {
                if (currentTarget.value === "" && !currentTarget.validity.badInput) {
                  setSpikeTakeInput(String(defaultContinuationRule.takeProfitPercent));
                }
              }} />
            <button type="submit" disabled={!canEdit}>保存评分与保护设置</button>
          </form>}
          {server && !trading.data?.enabled && <p>连接「账号设置」中的币安模拟盘或实盘后可启用自动下单。</p>}
          {background.mode === "browser" && <p>自动下单由本地后台监控执行。</p>}
          <div className={styles.monitorHelp}>
            <p><strong>走势评估（35 分）</strong> 门槛价为本条告警的实际触发价。观察触发后 5 秒，上涨看最低成交价，下跌看最高成交价，并结合最后一笔成交价判断。</p>
            <p>突破后站稳得 35 分，回吐后收复得 30 分；最后一笔保留至少四分之三突破幅度得 20 分，至少一半得 15 分，不到一半但仍在参考价突破侧得 5 分。回到或越过参考价得 0 分并跳过下单。</p>
            <p><strong>同向主动成交 + 订单簿深度（35 分）</strong> 完整告警区间内，上涨取主动买入占比，下跌取主动卖出占比。达到 55%、60%、65%、70%、75% 分别得 10、15、20、30、35 分。</p>
            <p>首次告警统计“参考价最后一次出现”到“告警触发”之间的成交。后续每次升级，统计“上一次告警”到“本次告警”之间的成交。告警确认后立即请求买卖两侧各最多 1000 档深度快照，按 USDT 挂单金额计算。上涨取买挂单占比，下跌取卖挂单占比，达到 60%、65%、70%、75%、80% 及以上分别加 5、10、15、20、25 分，低于 60% 得 0 分。两项相加封顶 35 分，快照不可用时补充分数为 0。</p>
            <p><strong>告警成交额额外加分（最多 20 分）</strong> 首报成交额倍数严格超过 100、200、400、700、1000 倍分别加 3、5、10、15、20 分。升级区间成交额除以上一次告警成交额，严格超过 5、10、20、50、100 倍分别加 3、5、10、15、20 分。</p>
            <p><strong>异动前横盘平静度（30 分）</strong> 仅在本轮首报计算，升级沿用。回看首报异动窗口之前 {continuation.lookbackHours} 小时的 1 分钟 K 线。整体振幅 ≤5% 得 10 分、≤8% 得 5 分；前后两半平均收盘价偏移 ≤1% 得 10 分、≤2% 得 5 分；最大单根振幅 ≤1% 得 10 分、≤2% 得 5 分。各项超过上限得 0 分。基础满分 100 分，加成交额奖励最高 120 分。</p>
            <p>首次确认告警后评估开仓，升级告警记录独立评分。总分 ≥ 80 且开启自动下单时，首报上涨做多、下跌做空，以 1 倍杠杆提交币安允许的最小市价单。首次信号有效期 45 秒。</p>
            <p>开仓成交后，后台以实际成交均价为基准，先挂标记价止损 {continuation.stopLossPercent}% 和止盈 {continuation.takeProfitPercent}%，再在止盈距离的 75% 处挂限价平多或平空。价格按合约步长校准。最长持仓 5 分钟，到期自动撤单并市价平仓。</p>
          </div>
        </section>
        <AlertRecords records={history} trades={trading.data?.trades} canDelete={recordsReady && canEdit} onDelete={deleteAlertRecords} />
      </div>
    </details>
  );

  return (
    <section id="market-alerts" className={styles.monitorPanel} aria-labelledby="market-alert-heading">
      <h2 id="market-alert-heading" className={styles.sectionTitle}>交易策略</h2>
      <StrategyRuntimeStatus health={health} background={background}
        browser={{ enabled, receiving: online && observedCoins > 0 }} />
      <details id="account-settings" className={styles.monitorFeature} {...accountDetails}>
        <summary className={styles.monitorSummary}><h3>账号设置</h3></summary>
        <div className={`${styles.monitorBody} ${styles.accountSettingsGrid}`}>
          <DingTalkSettings {...strategyNotifications} />
          <BinanceSettings availability={trading.mode} status={trading.data} error={trading.error} onChange={trading.changeAccount} />
        </div>
      </details>
      {strategy}
      <TestStrategy mode={trading.mode} status={trading.data} error={trading.error} onSubmit={trading.placeTestOrder} />
      <TradeRecords trades={trading.data?.trades ?? []} activeMode={trading.data?.enabled ? trading.data.mode : "off"}
        accountRevision={trading.data?.accountRevision} canDelete={trading.mode === "local"}
        onDelete={trading.deleteTrades} onClose={trading.closeTrade} onManage={trading.manageTrade} />
    </section>
  );
}
