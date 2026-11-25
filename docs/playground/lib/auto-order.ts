export const AUTO_ORDER_WATCH_MS = 60 * 60_000;
export const AUTO_ORDER_SYMBOL_LIMIT = 20;
export const AUTO_ORDER_HISTORY_LIMIT = 100;
export const marketSpikeStrategy = { id: "market-spike", name: "异动监控策略" };

type Strategy = { id: string; name: string };
export type AutoOrderSignal = { strategy: Strategy; symbol: string; time: number };
export type AutoOrderTick = { time: number; price: number };
export type AutoOrderQuote = AutoOrderTick & { low: number; high: number };
export type AutoOrderWatch = AutoOrderSignal & {
  status: "starting" | "watching" | "finished" | "stopped" | "failed";
  quote: AutoOrderQuote | null;
  failure?: "capacity";
};
export type AutoOrderWatchIdentity = { symbol: string; strategy: { id: string }; time: number };
export type AutoOrderRequest = {
  id: string;
  strategyId: string;
  symbol: string;
  side: "buy" | "sell";
  amount: number;
  time: number;
};

type Thread = { quote: (tick: AutoOrderTick) => void; stop: () => void };
export type StartAutoOrderThread = (symbol: string, report: (tick: AutoOrderTick) => void, fail: () => void) => Thread;
type Job = {
  watch: AutoOrderWatch;
  timer?: ReturnType<typeof setTimeout>;
  expiresAt: number;
  positionOpen: boolean;
  after: number;
};
type SymbolMonitor = { jobs: Map<string, Job>; thread?: Thread; lastPostedAt: number };
type StrategyState = { symbol: string; strategyId: string; positionOpen?: boolean; orderConditionMet?: boolean };

export function isAutoOrderActive({ status }: AutoOrderWatch) {
  return status === "starting" || status === "watching";
}

export function autoOrderKey({ symbol, strategy }: Pick<AutoOrderSignal, "symbol" | "strategy">) {
  return JSON.stringify([symbol, strategy.id]);
}

export function autoOrderWatchKey({ symbol, strategy, time }: AutoOrderWatchIdentity) {
  return JSON.stringify([symbol, strategy.id, time]);
}

export function autoOrderRequestKey({ strategyId, symbol, id }: AutoOrderRequest) {
  return JSON.stringify([strategyId, symbol, id]);
}

function validTick(tick: AutoOrderTick) {
  return Number.isSafeInteger(tick.time) && tick.time > 0 && Number.isFinite(tick.price) && tick.price > 0;
}

export function collectAutoOrderPrices(report: (tick: AutoOrderTick) => void) {
  let time = 0;
  return (tick: AutoOrderTick) => {
    if (!validTick(tick) || tick.time <= time) return;
    time = tick.time;
    report(tick);
  };
}

/** A contract shares one price worker. Each strategy owns its task and order requests. */
export function createAutoOrderMonitor(
  start: StartAutoOrderThread, publish: (watch: AutoOrderWatch) => void,
  recordRequest: (request: AutoOrderRequest) => boolean = () => false,
) {
  const monitors = new Map<string, SymbolMonitor>();

  function update(job: Job, fields: Partial<AutoOrderWatch>) {
    job.watch = { ...job.watch, ...fields };
    publish(job.watch);
  }

  function finish(job: Job, status: "finished" | "stopped" | "failed") {
    const { symbol, strategy } = job.watch;
    const monitor = monitors.get(symbol);
    if (monitor?.jobs.get(strategy.id) !== job) return;
    monitor.jobs.delete(strategy.id);
    if (monitor.jobs.size === 0) {
      monitors.delete(symbol);
      monitor.thread?.stop();
    }
    clearTimeout(job.timer);
    update(job, { status });
  }

  function scheduleExpiry(job: Job) {
    clearTimeout(job.timer);
    if (job.positionOpen) return;
    const remaining = job.expiresAt - Date.now();
    if (remaining <= 0) {
      finish(job, "finished");
      return;
    }
    job.timer = setTimeout(() => scheduleExpiry(job), remaining);
  }

  function submit(signal: AutoOrderSignal) {
    const { strategy, symbol, time } = signal;
    let monitor = monitors.get(symbol);
    const job = monitor?.jobs.get(strategy.id);
    if (job) {
      if (job.watch.time >= time) return;
      update(job, { strategy, time });
      job.expiresAt = Date.now() + AUTO_ORDER_WATCH_MS;
      scheduleExpiry(job);
      return;
    }
    if (!monitor) {
      if (monitors.size >= AUTO_ORDER_SYMBOL_LIMIT) {
        console.warn(`自动下单策略启动失败：已达到 ${AUTO_ORDER_SYMBOL_LIMIT} 个交易对上限。`, symbol, strategy.id, time);
        publish({ ...signal, status: "failed", quote: null, failure: "capacity" });
        return;
      }
      monitor = { jobs: new Map(), lastPostedAt: 0 };
      monitors.set(symbol, monitor);
    }
    const next: Job = {
      watch: { ...signal, status: "starting", quote: null },
      expiresAt: Date.now() + AUTO_ORDER_WATCH_MS, positionOpen: false,
      after: monitor.lastPostedAt,
    };
    monitor.jobs.set(strategy.id, next);
    if (!monitor.thread) {
      const current = monitor;
      try {
        current.thread = start(symbol, (tick) => {
          if (monitors.get(symbol) !== current) return;
          for (const task of current.jobs.values()) {
            if (tick.time <= task.after) continue;
            const previous = task.watch.quote;
            const quote = { ...tick, low: Math.min(previous?.low ?? tick.price, tick.price),
              high: Math.max(previous?.high ?? tick.price, tick.price) };
            update(task, { status: "watching", quote });
          }
        }, () => {
          if (monitors.get(symbol) !== current) return;
          for (const task of current.jobs.values()) finish(task, "failed");
        });
      } catch {
        finish(next, "failed");
        return;
      }
    }
    publish(next.watch);
    scheduleExpiry(next);
  }

  function updateStrategy({ symbol, strategyId, positionOpen, orderConditionMet }: StrategyState) {
    const job = monitors.get(symbol)?.jobs.get(strategyId);
    if (!job) return;
    if (positionOpen !== undefined) job.positionOpen = positionOpen;
    if (orderConditionMet) job.expiresAt = Date.now() + AUTO_ORDER_WATCH_MS;
    scheduleExpiry(job);
  }

  function requestOrder(request: AutoOrderRequest) {
    const { strategyId, symbol, id, time, side, amount } = request;
    if (!monitors.get(symbol)?.jobs.has(strategyId) || !id.trim() ||
        !Number.isSafeInteger(time) || time <= 0 || time > 8.64e15 ||
        (side !== "buy" && side !== "sell") || !Number.isFinite(amount) || amount <= 0) return false;
    if (!recordRequest(request)) return false;
    updateStrategy({ symbol, strategyId, orderConditionMet: true });
    return true;
  }

  return {
    submit,
    updateStrategy,
    requestOrder,
    stopStrategy: (strategyId: string) => {
      for (const monitor of monitors.values()) {
        const job = monitor.jobs.get(strategyId);
        if (job) finish(job, "stopped");
      }
    },
    observe: (symbol: string, tick: AutoOrderTick) => {
      const monitor = monitors.get(symbol);
      if (!monitor?.thread || !validTick(tick)) return;
      monitor.lastPostedAt = Math.max(monitor.lastPostedAt, tick.time);
      monitor.thread.quote(tick);
    },
    stop: () => {
      for (const monitor of monitors.values()) {
        for (const job of monitor.jobs.values()) finish(job, "stopped");
      }
    },
  };
}
