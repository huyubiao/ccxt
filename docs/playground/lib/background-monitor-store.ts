import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  defaultBackgroundRule, type BackgroundAlert, type BackgroundMonitorStatus,
  type BackgroundRecord, type BackgroundRule, type DeliveryState,
} from "./background-monitor-types";
import { MIN_ALERT_PERCENT, MIN_ALERT_SECONDS, spikeKey, type SpikeRecord } from "./price-alerts";

const leaseMs = 15_000;
const maxAttempts = 3;
const retentionMs = 30 * 86_400_000;
type ActiveWorker = Exclude<BackgroundMonitorStatus["worker"], "offline">;
type StoredAlert = Omit<BackgroundRecord, "event"> & { event: string };

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
  `);

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
    db.prepare("INSERT INTO monitor_rule VALUES (1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(value));
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
    const rows = db.prepare("SELECT * FROM monitor_alert ORDER BY confirmedAt DESC, id DESC LIMIT 100").all() as unknown as StoredAlert[];
    const spikes = db.prepare("SELECT event, status FROM monitor_spike ORDER BY time DESC, id DESC LIMIT 100").all() as
      { event: string; status: SpikeRecord["status"] }[];
    return { configured: saved !== null, rule: saved ?? defaultBackgroundRule, worker,
      records: rows.map(({ id, event, confirmedAt, delivery, attempts, lastAttempt, lastResult }) =>
        ({ id, event: JSON.parse(event), confirmedAt, delivery, attempts, lastAttempt, lastResult })),
      spikes: spikes.map(({ event, status }) => ({ ...JSON.parse(event), status: worker === "offline" && status === "pending" ? "interrupted" : status })) };
  }

  function recordSpike(event: SpikeRecord) {
    db.prepare(`INSERT INTO monitor_spike VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      event = excluded.event, status = excluded.status`).run(spikeKey(event), JSON.stringify(event), event.time, event.status);
  }

  function interruptSpikes(owner: string) {
    db.prepare(`UPDATE monitor_spike SET status = 'interrupted' WHERE status = 'pending'
      AND EXISTS (SELECT 1 FROM monitor_worker WHERE key = 1 AND owner = ?)`).run(owner);
  }

  function record(id: string, event: BackgroundAlert, now: number, notify: boolean) {
    return db.prepare(`INSERT OR IGNORE INTO monitor_alert (id, event, confirmedAt, delivery, nextAttempt)
      VALUES (?, ?, ?, ?, ?)`).run(id, JSON.stringify(event), now, notify ? "queued" : "disabled", now).changes === 1;
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
    return row && { ...row, event: JSON.parse(row.event) as BackgroundAlert };
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
  }

  return { rule, saveRule, workerState, status, heartbeat, release, record, saveContext, recordSpike, interruptSpikes,
    claim, finish, prune, close: () => db.close() };
}

let store: ReturnType<typeof openBackgroundStore> | undefined;
export function backgroundStore() {
  return store ??= openBackgroundStore();
}
