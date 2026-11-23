import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, type Dispatcher } from "undici";
import { createAutoOrderMonitor, marketSpikeStrategy } from "./auto-order";
import { startAutoOrderThread } from "./auto-order-thread";
import { openBackgroundStore } from "./background-monitor-store";
import type { BackgroundAlert, BackgroundRule } from "./background-monitor-types";
import { getBinanceAlertRatios } from "./binance-alert-ratios";
import { getBinanceFuturesInstruments } from "./binance-markets";
import { getAlertTurnoverComparison } from "./binance-volume";
import type { MarketInstrument } from "./market-lookup";
import {
  getTurnoverMultiple, recordPriceLevel, settlePriceSeries,
  type LeveledPriceState, type PriceAlertLevel, type PriceAlertSeries, type SpikeRecord,
} from "./price-alerts";
import { VOLUME_DELAY_MS } from "./short-volume";
import { createMarketSpikeEvent, formatNotificationEvent } from "./strategy-notification-events";
import { strategyNotifier } from "./strategy-notifications";

const stream = "wss://fstream.binance.com/market/ws/!miniTicker@arr";
const directions = ["up", "down"] as const;
const queueLimit = 100;
const concurrency = 2;
const maxQueueAge = 15_000;

type Tick = { e?: string; s?: string; c?: string; E?: number; st?: number };
type Job = { pair: MarketInstrument; event: ReturnType<typeof alert>; state: LeveledPriceState; series: PriceAlertSeries };

function alert(pair: MarketInstrument, move: PriceAlertLevel, threshold: number, seconds: number) {
  return { symbol: pair.id, time: move.sample.time, level: move.level,
    previous: move.previous, price: move.sample.price, change: move.change, threshold, seconds };
}

export function createBackgroundDetector(rule: BackgroundRule, confirm: (event: BackgroundAlert) => void,
  schedule: (job: Job) => void) {
  const samples = new Map<string, { lastTick: number; up: LeveledPriceState; down: LeveledPriceState }>();
  return (pair: MarketInstrument, ticksAt: number, price: number) => {
    let state = samples.get(pair.id);
    if (state && ticksAt <= state.lastTick) return;
    if (!state || ticksAt - state.lastTick > rule.seconds * 1000) {
      state = { lastTick: ticksAt, up: { samples: [] }, down: { samples: [] } };
      samples.set(pair.id, state);
    }
    state.lastTick = ticksAt;
    for (const direction of directions) {
      const threshold = rule[direction];
      if (threshold === null) continue;
      const result = recordPriceLevel(state[direction], { time: ticksAt, price }, threshold, rule.seconds);
      if (!result) continue;
      const event = alert(pair, result.move, threshold, rule.seconds);
      if (result.needsTurnover) schedule({ pair, event, state: state[direction], series: result.series });
      else confirm(createMarketSpikeEvent(event, result.volume, price));
    }
  };
}

export async function runBackgroundMonitor(signal: AbortSignal, dispatcher?: Dispatcher, exitWhenDisabled = false) {
  const store = openBackgroundStore();
  const owner = randomUUID();
  let stopVersion = store.autoOrderStopVersion(marketSpikeStrategy.id);
  const autoOrders = createAutoOrderMonitor(
    startAutoOrderThread, (watch) => store.saveAutoOrderWatch(owner, watch, watch.strategy.id === marketSpikeStrategy.id ? stopVersion : 0),
    (request) => store.recordAutoOrderRequest(owner, request, request.strategyId === marketSpikeStrategy.id ? stopVersion : 0),
  );
  let acquired = false;
  let currentRule = "";
  let scope = new AbortController();
  let socket: WebSocket | undefined;
  let lastFrame = 0;
  let nextConnection = 0;
  let nextDirectory = 0;
  let loadingDirectory = false;
  let pairs = new Map<string, MarketInstrument>();
  let observe: ReturnType<typeof createBackgroundDetector>;
  let delivery: Promise<void> | undefined;
  let loadContext: Promise<void> | undefined;
  const pendingContext: { id: string; event: BackgroundAlert }[] = [];
  let nextPrune = 0;
  let active = 0;
  const pending: Job[] = [];

  function clearWindow() {
    scope.abort();
    scope = new AbortController();
    pending.length = 0;
    store.interruptSpikes(owner);
    const connection = socket;
    socket = undefined;
    connection?.close();
  }

  function trackRule(rule: BackgroundRule) {
    const key = JSON.stringify(rule);
    const version = store.autoOrderStopVersion(marketSpikeStrategy.id);
    if (key === currentRule && version === stopVersion) return;
    if (version !== stopVersion) {
      autoOrders.stopStrategy(marketSpikeStrategy.id);
      stopVersion = version;
    }
    currentRule = key;
    clearWindow();
    nextConnection = 0;
  }

  function logSpike(event: Job["event"], status: SpikeRecord["status"], requiredMultiple: number | null,
    volume?: SpikeRecord["volume"]) {
    store.recordSpike({ ...event, status, requiredMultiple, volume });
  }

  function confirm(event: BackgroundAlert, rule: BackgroundRule, requiredMultiple: number | null = null) {
    const persisted = store.rule();
    if (JSON.stringify(persisted) !== currentRule || !persisted.enabled ||
        store.autoOrderStopVersion(marketSpikeStrategy.id) !== stopVersion) return;
    const message = formatNotificationEvent(event);
    if (message?.deduplicationKey) {
      logSpike(event, "alerted", requiredMultiple, event.volume);
      const id = message.deduplicationKey;
      const signal = { strategy: marketSpikeStrategy, symbol: event.symbol, time: event.time };
      if (store.record(id, event, Date.now(), rule.notify, signal, stopVersion)) {
        if (pendingContext.length < queueLimit) pendingContext.push({ id, event });
        else store.saveContext(id, "queue-skipped");
      }
    }
  }

  function queue(job: Job, rule: BackgroundRule) {
    if (pending.length < queueLimit) {
      pending.push(job);
      logSpike(job.event, "pending", rule.turnoverMultiple);
    } else {
      settlePriceSeries(job.state, job.series, null);
      logSpike(job.event, "skipped", rule.turnoverMultiple);
    }
  }

  async function check(job: Job, rule: BackgroundRule, request: AbortSignal) {
    const { pair, event, state, series } = job;
    try {
      await delay(Math.max(0, event.time + VOLUME_DELAY_MS - Date.now()), undefined, { signal: request });
      const data = await getAlertTurnoverComparison(pair, event.time + 1, rule.seconds);
      if (request.aborted || signal.aborted) return;
      const multiple = getTurnoverMultiple(data);
      const timely = Date.now() - event.time <= maxQueueAge + 10_000;
      const volume = { ...data, multiple };
      const passed = timely && multiple !== null && multiple >= rule.turnoverMultiple;
      const move = settlePriceSeries(state, series, passed ? volume : null);
      if (move) {
        const confirmed = createMarketSpikeEvent(alert(pair, move, event.threshold, rule.seconds), volume, state.samples.at(-1)?.price);
        const upgraded = move.level !== event.level;
        if (upgraded) logSpike(event, "upgraded", rule.turnoverMultiple, volume);
        confirm(confirmed, rule, upgraded ? null : rule.turnoverMultiple);
      } else {
        logSpike(event, !timely || multiple === null ? "unavailable" : "below-threshold", rule.turnoverMultiple, volume);
      }
    } catch {
      settlePriceSeries(state, series, null);
      if (!request.aborted && !signal.aborted) logSpike(event, "unavailable", rule.turnoverMultiple);
    }
  }

  function drain(rule: BackgroundRule) {
    while (active < concurrency && pending.length) {
      const job = pending.shift()!;
      if (Date.now() - job.event.time > maxQueueAge) {
        settlePriceSeries(job.state, job.series, null);
        logSpike(job.event, "unavailable", rule.turnoverMultiple);
        continue;
      }
      active++;
      void check(job, rule, scope.signal).finally(() => { active--; });
    }
  }

  function connect(rule: BackgroundRule, now: number) {
    const connection = new WebSocket(stream, { dispatcher });
    socket = connection;
    lastFrame = now;
    const request = scope.signal;
    observe = createBackgroundDetector(rule, (event) => confirm(event, rule), (job) => queue(job, rule));
    connection.addEventListener("message", ({ data }) => {
      if (socket !== connection || request.aborted || signal.aborted || typeof data !== "string") return;
      let ticks: Tick[];
      try {
        const value = JSON.parse(data);
        if (!Array.isArray(value)) return;
        ticks = value;
      } catch {
        return;
      }
      lastFrame = Date.now();
      for (const tick of ticks) {
        if (tick?.e !== "24hrMiniTicker" || tick.st === 2 || typeof tick.s !== "string" ||
            typeof tick.E !== "number" || !Number.isSafeInteger(tick.E) ||
            tick.E > lastFrame + 5_000 || tick.E < lastFrame - 15_000) continue;
        const pair = pairs.get(tick.s);
        const price = Number(tick.c);
        if (pair && Number.isFinite(price) && price > 0) {
          observe(pair, tick.E, price);
          autoOrders.observe(pair.id, { time: tick.E, price });
        }
      }
      drain(rule);
    });
    function disconnected() {
      if (socket !== connection) return;
      clearWindow();
      nextConnection = Date.now() + 5_000;
    }
    connection.addEventListener("error", disconnected);
    connection.addEventListener("close", disconnected);
  }

  async function deliver() {
    const job = store.claim(Date.now());
    if (!job) return;
    const message = formatNotificationEvent(job.event);
    const status = message ? await strategyNotifier.send(message) : "invalid";
    store.finish(job.id, job.attempts, status, Date.now());
  }

  async function loadRatios({ id, event }: { id: string; event: BackgroundAlert }) {
    const context = await getBinanceAlertRatios(event.symbol, event.time).catch(() => "request-failed" as const);
    store.saveContext(id, context);
  }

  try {
    while (!signal.aborted) {
      const now = Date.now();
      const rule = store.rule();
      if (!rule.enabled && exitWhenDisabled) break;
      const state = !rule.enabled ? "idle" : socket?.readyState === WebSocket.OPEN ? "connected" : "connecting";
      if (!store.heartbeat(owner, state, now)) break;
      if (!acquired) {
        store.stopAutoOrderWatches(owner);
        acquired = true;
      }
      trackRule(rule);
      if (now >= nextPrune) {
        store.prune(now);
        nextPrune = now + 3_600_000;
      }
      if (rule.enabled) {
        for (const { id, signal } of store.pendingAutoOrderSignals()) {
          autoOrders.submit(signal);
          store.finishAutoOrderSignal(id, owner);
        }
        if (!loadingDirectory && now >= nextDirectory) {
          loadingDirectory = true;
          nextDirectory = now + 60_000;
          void getBinanceFuturesInstruments().then((list) => { pairs = new Map(list.map((pair) => [pair.id, pair])); })
            .catch(() => { nextDirectory = Date.now() + 5_000; }).finally(() => { loadingDirectory = false; });
        }
        if (socket && now - lastFrame > 15_000) {
          clearWindow();
          nextConnection = now + 5_000;
        }
        if (!socket && pairs.size && now >= nextConnection) {
          try { connect(rule, now); } catch { nextConnection = now + 5_000; }
        }
        drain(rule);
        if (rule.notify && !delivery) {
          delivery = deliver().catch(() => { console.error("后台告警送达状态写入失败。"); }).finally(() => { delivery = undefined; });
        }
      } else autoOrders.stopStrategy(marketSpikeStrategy.id);
      if (!loadContext && pendingContext.length) {
        loadContext = loadRatios(pendingContext.shift()!).catch(() => {
          console.error("无法写入告警多空比。");
        }).finally(() => { loadContext = undefined; });
      }
      await delay(1000, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    autoOrders.stop();
    clearWindow();
    await Promise.all([delivery, loadContext]);
    store.release(owner);
    store.close();
  }
}
