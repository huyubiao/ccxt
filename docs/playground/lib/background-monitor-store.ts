import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SPIKE_RECORD_LIMIT } from "./alert-history";
import {
  AUTO_ORDER_HISTORY_LIMIT, isAutoOrderActive, marketSpikeStrategy,
  type AutoOrderRequest, type AutoOrderSignal, type AutoOrderWatch, type AutoOrderWatchIdentity,
} from "./auto-order";
import {
  defaultBackgroundRule, type BackgroundAlert, type BackgroundMonitorStatus,
  type BackgroundRecord, type BackgroundRule, type DeliveryState,
} from "./background-monitor-types";
import { forecastAlertDirection, MIN_ALERT_PERCENT, MIN_ALERT_SECONDS, spikeKey, type SpikeIdentity, type SpikeRecord } from "./price-alerts";

const leaseMs = 15_000;
const maxAttempts = 3;
const retentionMs = 30 * 86_400_000;
const activeAutoOrder = "json_extract(watch, '$.status') IN ('starting', 'watching')";
const visibleAutoOrder = "json_extract(watch, '$.deleted') IS NULL";
const currentAutoOrderVersion = "COALESCE((SELECT version FROM auto_order_strategy_stop WHERE strategyId = ?), 0) = ?";
type ActiveWorker = Exclude<BackgroundMonitorStatus["worker"], "offline">;
type StoredAlert = Omit<BackgroundRecord, "event"> & { event: string };

function readAlert(event: string): BackgroundAlert {
  const saved = JSON.parse(event) as BackgroundAlert;
  return { ...saved, forecastDirection: saved.forecastDirection ?? forecastAlertDirection(saved) };
}

export function monitorDatabasePath() {
  return process.env.PLAYGROUND_MONITOR_DB || path.resolve(".cache", "market-monitor", "monitor.sqlite");
}

export function openBackgroundStore(file = monitorDatabasePath()) {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS monitor_rule (key INTEGER PRIMARY KEY CHECK (key = 1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS monitor_worker (
      key INTEGER PRIMARY KEY CHECK (key = 1), owner TEXT, heartbeat INTEGER NOT NULL, state TEXT NOT NULL
    );
    INSERT OR IGNORE INTO monitor_worker VALUES (1, NULL, 0, 'idle');
    CREATE TABLE IF NOT EXISTS monitor_alert (
      id TEXT PRIMARY KEY, event TEXT NOT NULL, confirmedAt INTEGER NOT NULL,
      delivery TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lastAttempt INTEGER, lastResult TEXT, nextAttempt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS monitor_alert_time ON monitor_alert (confirmedAt);
    CREATE INDEX IF NOT EXISTS monitor_alert_queue ON monitor_alert (delivery, nextAttempt);
    CREATE TABLE IF NOT EXISTS monitor_spike (
      id TEXT PRIMARY KEY, event TEXT NOT NULL, time INTEGER NOT NULL, status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS monitor_spike_time ON monitor_spike (time);
    CREATE TABLE IF NOT EXISTS monitor_deleted_spike (
      id TEXT PRIMARY KEY, symbol TEXT NOT NULL, time INTEGER NOT NULL, threshold REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS monitor_deleted_spike_identity ON monitor_deleted_spike (symbol, time, threshold);
    CREATE TABLE IF NOT EXISTS auto_order_signal (id TEXT PRIMARY KEY, signal TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auto_order_strategy_stop (strategyId TEXT PRIMARY KEY, version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auto_order_request (
      strategyId TEXT NOT NULL, symbol TEXT NOT NULL, id TEXT NOT NULL, side TEXT NOT NULL, amount REAL NOT NULL, time INTEGER NOT NULL,
      PRIMARY KEY (strategyId, symbol, id)
    );
    CREATE INDEX IF NOT EXISTS auto_order_request_time ON auto_order_request (strategyId, time DESC);
  `);
  const tableExists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
  if (!tableExists.get("auto_order_strategy_watch")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!tableExists.get("auto_order_strategy_watch")) {
        db.exec(`CREATE TABLE auto_order_strategy_watch (
          symbol TEXT NOT NULL, strategyId TEXT NOT NULL, watch TEXT NOT NULL, time INTEGER NOT NULL,
          PRIMARY KEY (symbol, strategyId)
        )`);
        if (tableExists.get("auto_order_watch")) {
          db.exec(`INSERT INTO auto_order_strategy_watch
            SELECT old.symbol, json_extract(source.value, '$.id'),
              json_object('symbol', old.symbol,
                'strategy', json_object('id', json_extract(source.value, '$.id'), 'name', json_extract(source.value, '$.name')),
                'time', json_extract(source.value, '$.time'),
                'status', CASE WHEN json_extract(old.watch, '$.status') IN ('queued', 'starting', 'watching')
                  THEN 'stopped' ELSE json_extract(old.watch, '$.status') END,
                'quote', json_extract(old.watch, '$.quote')),
              json_extract(source.value, '$.time')
            FROM auto_order_watch AS old, json_each(old.watch, '$.sources') AS source`);
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }

  function savedRule(): BackgroundRule | null {
    const row = db.prepare("SELECT value FROM monitor_rule WHERE key = 1").get() as { value: string } | undefined;
    if (!row) return null;
    const saved = JSON.parse(row.value) as BackgroundRule;
    const up = saved.up === null ? null : Math.max(MIN_ALERT_PERCENT, saved.up);
    const down = saved.down === null ? null : Math.min(-MIN_ALERT_PERCENT, saved.down);
    const seconds = Math.max(MIN_ALERT_SECONDS, saved.seconds);
    if (up === saved.up && down === saved.down && seconds === saved.seconds) return saved;
    const updated = { ...saved, up, down, seconds };
    db.prepare("UPDATE monitor_rule SET value = ? WHERE key = 1 AND value = ?").run(JSON.stringify(updated), row.value);
    return updated;
  }

  function rule() {
    return savedRule() ?? defaultBackgroundRule;
  }

  function saveRule(value: BackgroundRule) {
    const save = db.prepare("INSERT INTO monitor_rule VALUES (1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const serialized = JSON.stringify(value);
    if (value.enabled) {
      save.run(serialized);
      return;
    }
    const strategyId = marketSpikeStrategy.id;
    db.exec("BEGIN IMMEDIATE");
    try {
      save.run(serialized);
      db.prepare(`INSERT INTO auto_order_strategy_stop VALUES (?, 1)
        ON CONFLICT(strategyId) DO UPDATE SET version = version + 1`).run(strategyId);
      db.prepare(`UPDATE auto_order_strategy_watch SET watch = json_set(watch, '$.status', 'stopped')
        WHERE strategyId = ? AND ${activeAutoOrder}`).run(strategyId);
      db.prepare("DELETE FROM auto_order_signal WHERE json_extract(signal, '$.strategy.id') = ?").run(strategyId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function autoOrderStopVersion(strategyId: string) {
    const row = db.prepare("SELECT version FROM auto_order_strategy_stop WHERE strategyId = ?").get(strategyId) as
      { version: number } | undefined;
    return row?.version ?? 0;
  }

  function heartbeat(owner: string, state: ActiveWorker, now: number) {
    return db.prepare(`UPDATE monitor_worker SET owner = ?, heartbeat = ?, state = ?
      WHERE key = 1 AND (owner = ? OR owner IS NULL OR heartbeat <= ?)`)
      .run(owner, now, state, owner, now - leaseMs).changes === 1;
  }

  function release(owner: string) {
    db.prepare("UPDATE monitor_worker SET owner = NULL, heartbeat = 0 WHERE owner = ?").run(owner);
  }

  function workerState(now: number): BackgroundMonitorStatus["worker"] {
    const worker = db.prepare("SELECT owner, heartbeat, state FROM monitor_worker WHERE key = 1").get() as
      { owner: string | null; heartbeat: number; state: ActiveWorker };
    return worker.owner && worker.heartbeat > now - leaseMs ? worker.state : "offline";
  }

  function status(now: number): BackgroundMonitorStatus {
    const saved = savedRule();
    const worker = workerState(now);
    const rows = db.prepare(`SELECT * FROM monitor_alert AS alert WHERE NOT EXISTS (
      SELECT 1 FROM monitor_deleted_spike WHERE symbol = json_extract(alert.event, '$.symbol')
        AND time = json_extract(alert.event, '$.time') AND threshold = json_extract(alert.event, '$.threshold')
    ) ORDER BY confirmedAt DESC, id DESC LIMIT ?`).all(SPIKE_RECORD_LIMIT) as unknown as StoredAlert[];
    const spikes = db.prepare(`SELECT event, status FROM monitor_spike AS spike WHERE NOT EXISTS (
      SELECT 1 FROM monitor_deleted_spike WHERE id = spike.id
    ) ORDER BY time DESC, id DESC LIMIT ?`).all(SPIKE_RECORD_LIMIT) as
      { event: string; status: SpikeRecord["status"] }[];
    const autoOrders = (db.prepare(`SELECT watch FROM auto_order_strategy_watch WHERE ${visibleAutoOrder}
      ORDER BY CASE WHEN ${activeAutoOrder} THEN 0 ELSE 1 END, time DESC
      LIMIT max(?, (SELECT COUNT(*) FROM auto_order_strategy_watch WHERE ${visibleAutoOrder} AND ${activeAutoOrder}))`)
      .all(AUTO_ORDER_HISTORY_LIMIT) as
      { watch: string }[]).map(({ watch }) => {
      const saved = JSON.parse(watch) as AutoOrderWatch;
      return worker === "offline" && isAutoOrderActive(saved) ? { ...saved, status: "stopped" as const } : saved;
    });
    const requests = db.prepare(`SELECT id, strategyId, symbol, side, amount, time FROM (
      SELECT *, row_number() OVER (PARTITION BY strategyId ORDER BY time DESC, id DESC) AS rank FROM auto_order_request
    ) WHERE rank <= ? ORDER BY time DESC, id DESC`).all(AUTO_ORDER_HISTORY_LIMIT) as AutoOrderRequest[];
    return { configured: saved !== null, rule: saved ?? defaultBackgroundRule, worker,
      records: rows.map(({ id, event, confirmedAt, delivery, attempts, lastAttempt, lastResult }) =>
        ({ id, event: readAlert(event), confirmedAt, delivery, attempts, lastAttempt, lastResult })),
      spikes: spikes.map(({ event, status }) => ({ ...JSON.parse(event), status: worker === "offline" && status === "pending" ? "interrupted" : status })),
      autoOrders, autoOrderRequests: requests.map((request) => ({ ...request })) };
  }

  function recordSpike(event: SpikeRecord) {
    db.prepare(`INSERT INTO monitor_spike VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      event = excluded.event, status = excluded.status`).run(spikeKey(event), JSON.stringify(event), event.time, event.status);
  }

  function deleteSpikes(records: readonly SpikeIdentity[]) {
    // A deleted trigger stays out of the table even if its pending check finishes later.
    const entries = records.map((record) => [spikeKey(record), record.symbol, record.time, record.threshold]);
    db.prepare(`INSERT OR IGNORE INTO monitor_deleted_spike (id, symbol, time, threshold)
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
        json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?)`).run(JSON.stringify(entries));
  }

  function deleteAutoOrderWatches(records: readonly AutoOrderWatchIdentity[]) {
    db.prepare(`UPDATE auto_order_strategy_watch SET watch = json_set(watch, '$.deleted', 1)
      WHERE (symbol, strategyId, time) IN (
        SELECT json_extract(value, '$.symbol'), json_extract(value, '$.strategy.id'), json_extract(value, '$.time')
        FROM json_each(?)
      )`).run(JSON.stringify(records));
  }

  function interruptSpikes(owner: string) {
    db.prepare(`UPDATE monitor_spike SET status = 'interrupted' WHERE status = 'pending'
      AND EXISTS (SELECT 1 FROM monitor_worker WHERE key = 1 AND owner = ?)`).run(owner);
  }

  function record(id: string, event: BackgroundAlert, now: number, notify: boolean, signal?: AutoOrderSignal, stopVersion = 0) {
    const insert = db.prepare(`INSERT OR IGNORE INTO monitor_alert (id, event, confirmedAt, delivery, nextAttempt)
      VALUES (?, ?, ?, ?, ?)`);
    const values = [id, JSON.stringify(event), now, notify ? "queued" : "disabled", now];
    if (!signal) return insert.run(...values).changes === 1;
    db.exec("BEGIN");
    try {
      const recorded = insert.run(...values).changes === 1;
      if (recorded) {
        db.prepare(`INSERT INTO auto_order_signal SELECT ?, ? WHERE ${currentAutoOrderVersion}`)
          .run(id, JSON.stringify(signal), signal.strategy.id, stopVersion);
      }
      db.exec("COMMIT");
      return recorded;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function pendingAutoOrderSignals() {
    const rows = db.prepare("SELECT id, signal FROM auto_order_signal ORDER BY rowid LIMIT 100").all() as
      { id: string; signal: string }[];
    return rows.map(({ id, signal }) => ({ id, signal: JSON.parse(signal) as AutoOrderSignal }));
  }

  function finishAutoOrderSignal(id: string, owner: string) {
    db.prepare(`DELETE FROM auto_order_signal WHERE id = ?
      AND EXISTS (SELECT 1 FROM monitor_worker WHERE key = 1 AND owner = ?)`).run(id, owner);
  }

  function saveAutoOrderWatch(owner: string, watch: AutoOrderWatch, stopVersion = 0) {
    db.prepare(`INSERT INTO auto_order_strategy_watch (symbol, strategyId, watch, time)
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM monitor_worker WHERE key = 1 AND owner = ?) AND ${currentAutoOrderVersion}
      ON CONFLICT(symbol, strategyId) DO UPDATE SET watch = CASE
        WHEN auto_order_strategy_watch.time = excluded.time AND json_extract(auto_order_strategy_watch.watch, '$.deleted') = 1
        THEN json_set(excluded.watch, '$.deleted', 1) ELSE excluded.watch END, time = excluded.time
      WHERE auto_order_strategy_watch.time <= excluded.time`)
      .run(watch.symbol, watch.strategy.id, JSON.stringify(watch), watch.time, owner, watch.strategy.id, stopVersion);
  }

  function recordAutoOrderRequest(owner: string, { strategyId, symbol, id, side, amount, time }: AutoOrderRequest, stopVersion = 0) {
    return db.prepare(`INSERT OR IGNORE INTO auto_order_request (strategyId, symbol, id, side, amount, time)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM monitor_worker WHERE key = 1 AND owner = ?)
      AND ${currentAutoOrderVersion}`).run(strategyId, symbol, id, side, amount, time, owner, strategyId, stopVersion).changes === 1;
  }

  function stopAutoOrderWatches(owner: string) {
    db.prepare(`UPDATE auto_order_strategy_watch SET watch = json_set(watch, '$.status', 'stopped')
      WHERE ${activeAutoOrder}
      AND EXISTS (SELECT 1 FROM monitor_worker WHERE key = 1 AND owner = ?)`).run(owner);
  }

  function saveContext(id: string, context: NonNullable<BackgroundAlert["context"]>) {
    db.prepare("UPDATE monitor_alert SET event = json_set(event, '$.context', json(?)) WHERE id = ?")
      .run(JSON.stringify(context), id);
  }

  function claim(now: number) {
    // A process that dies during delivery cannot determine whether the robot received the message.
    db.prepare(`UPDATE monitor_alert SET delivery = 'unknown', lastResult = 'unknown' WHERE delivery = 'sending' AND lastAttempt <= ?`)
      .run(now - 60_000);
    const row = db.prepare(`UPDATE monitor_alert SET delivery = 'sending', attempts = attempts + 1, lastAttempt = ?
      WHERE id = (SELECT id FROM monitor_alert WHERE delivery = 'queued' AND nextAttempt <= ?
        ORDER BY nextAttempt, confirmedAt LIMIT 1) RETURNING id, event, attempts`).get(now, now) as
      { id: string; event: string; attempts: number } | undefined;
    return row && { ...row, event: readAlert(row.event) };
  }

  function finish(id: string, attempts: number, result: DeliveryState, now: number) {
    const retry = (result === "rate-limited" || result === "failed" || result === "config-unavailable") && attempts < maxAttempts;
    db.prepare(`UPDATE monitor_alert SET delivery = ?, nextAttempt = ?, lastResult = ?
      WHERE id = ? AND attempts = ? AND delivery = 'sending'`)
      .run(retry ? "queued" : result, now + attempts * 60_000, result, id, attempts);
  }

  function prune(now: number) {
    db.prepare("DELETE FROM monitor_alert WHERE confirmedAt < ? AND delivery != 'sending'").run(now - retentionMs);
    db.prepare("DELETE FROM monitor_spike WHERE time < ?").run(now - retentionMs);
    db.prepare(`DELETE FROM monitor_deleted_spike AS deleted WHERE time < ? AND NOT EXISTS (
      SELECT 1 FROM monitor_alert WHERE json_extract(event, '$.symbol') = deleted.symbol
        AND json_extract(event, '$.time') = deleted.time AND json_extract(event, '$.threshold') = deleted.threshold
    )`).run(now - retentionMs);
    db.prepare(`DELETE FROM auto_order_strategy_watch WHERE time < ? AND NOT (${activeAutoOrder})`).run(now - retentionMs);
    db.prepare("DELETE FROM auto_order_request WHERE time < ?").run(now - retentionMs);
    db.prepare("DELETE FROM auto_order_signal WHERE NOT EXISTS (SELECT 1 FROM monitor_alert WHERE id = auto_order_signal.id)").run();
  }

  return { rule, saveRule, workerState, status, heartbeat, release, record, saveContext, recordSpike, deleteSpikes, interruptSpikes,
    claim, finish, prune, pendingAutoOrderSignals, finishAutoOrderSignal, saveAutoOrderWatch, recordAutoOrderRequest, stopAutoOrderWatches,
    autoOrderStopVersion, deleteAutoOrderWatches, close: () => db.close() };
}

let store: ReturnType<typeof openBackgroundStore> | undefined;
export function backgroundStore() {
  return store ??= openBackgroundStore();
}
