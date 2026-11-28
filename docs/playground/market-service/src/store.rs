use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use tokio::task::JoinHandle;

use crate::now_ms;
use crate::strategy::{Rule, MARKET_SPIKE_ID as STRATEGY, MARKET_SPIKE_NAME};

const ACTIVE: &str = "json_extract(watch, '$.status') IN ('starting', 'watching')";
const VISIBLE: &str = "json_extract(watch, '$.deleted') IS NULL";
const LEASE_MS: i64 = 15_000;
const RETENTION_MS: i64 = 30 * 86_400_000;
const TRADE_OPERATION_MS: i64 = 60_000;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub fn write_private_json(path: &Path, data: &impl serde::Serialize) -> Result<()> {
    use std::io::Write;
    let directory = path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::create_dir_all(directory)?;
    let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let saved = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec(data)?)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if saved.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    saved
}

pub struct Store(Mutex<Connection>, PathBuf);

pub struct TradeOperation {
    store: Arc<Store>,
    trade_id: String,
    owner: String,
    renewal: JoinHandle<()>,
}

impl Drop for TradeOperation {
    fn drop(&mut self) {
        self.renewal.abort();
        if let Ok(db) = self.store.db() {
            let _ = db.execute("DELETE FROM trade_operation WHERE tradeId = ? AND owner = ?", [&self.trade_id, &self.owner]);
        }
    }
}

pub struct Delivery {
    pub id: String,
    pub event: Value,
    pub attempts: i64,
}

impl Store {
    pub fn open_default() -> Result<Self> {
        let path = std::env::var_os("PLAYGROUND_MONITOR_DB")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(".cache/market-monitor/monitor.sqlite"));
        Self::open(&path)
    }

    #[cfg(test)]
    pub fn open_memory() -> Result<Self> {
        Self::open(Path::new(":memory:"))
    }

    pub(crate) fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)?;
        }
        let mut db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.execute_batch(include_str!("store.sql"))?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let has_table = |table| {
            tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?)",
                [table],
                |row| row.get::<_, bool>(0),
            )
        };
        if !has_table("auto_order_strategy_watch")? {
            tx.execute_batch("CREATE TABLE auto_order_strategy_watch (
                symbol TEXT NOT NULL, strategyId TEXT NOT NULL, watch TEXT NOT NULL, time INTEGER NOT NULL,
                PRIMARY KEY (symbol, strategyId)
            );")?;
            if has_table("auto_order_watch")? {
                tx.execute_batch("INSERT INTO auto_order_strategy_watch
                    SELECT old.symbol, json_extract(source.value, '$.id'),
                        json_object('symbol', old.symbol,
                            'strategy', json_object('id', json_extract(source.value, '$.id'), 'name', json_extract(source.value, '$.name')),
                            'time', json_extract(source.value, '$.time'),
                            'status', CASE WHEN json_extract(old.watch, '$.status') IN ('queued', 'starting', 'watching')
                                THEN 'stopped' ELSE json_extract(old.watch, '$.status') END,
                            'quote', json_extract(old.watch, '$.quote')),
                        json_extract(source.value, '$.time')
                    FROM auto_order_watch AS old, json_each(old.watch, '$.sources') AS source;")?;
            }
        }
        tx.commit()?;
        Ok(Self(Mutex::new(db), path.to_owned()))
    }

    pub fn trading_account_path(&self) -> PathBuf {
        self.1.with_extension("binance-account.json")
    }

    fn db(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.0
            .lock()
            .map_err(|_| "market monitor database lock poisoned".into())
    }

    pub fn rule(&self) -> Result<Rule> {
        Ok(read_rule(&*self.db()?)?.unwrap_or_default())
    }

    pub fn save_rule(&self, rule: Rule) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if read_rule(&tx)? != Some(rule) {
            Self::interrupt_pending_evaluations(&tx)?;
        }
        tx.execute("INSERT INTO monitor_rule VALUES (1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [serde_json::to_string(&rule)?])?;
        if !rule.enabled {
            tx.execute("INSERT INTO auto_order_strategy_stop VALUES (?, 1) ON CONFLICT(strategyId) DO UPDATE SET version = version + 1", [STRATEGY])?;
            tx.execute(&format!("UPDATE auto_order_strategy_watch SET watch = json_set(watch, '$.status', 'stopped') WHERE strategyId = ? AND {ACTIVE}"), [STRATEGY])?;
            tx.execute(
                "DELETE FROM auto_order_signal WHERE json_extract(signal, '$.strategy.id') = ?",
                [STRATEGY],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn disable_auto_trade(&self) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute("UPDATE monitor_rule SET value = json_set(value, '$.continuation.autoTrade', json('false'))
            WHERE key = 1 AND json_extract(value, '$.continuation.autoTrade') = 1", [])?;
        if changed > 0 {
            Self::interrupt_pending_evaluations(&tx)?;
        }
        tx.commit()?;
        Ok(())
    }

    fn interrupt_pending_evaluations(db: &Connection) -> Result<()> {
        db.execute("UPDATE monitor_alert SET event = json_set(event, '$.continuation.status', 'interrupted')
            WHERE json_extract(event, '$.continuation.status') = 'pending'", [])?;
        Ok(())
    }

    pub fn stop_version(&self) -> Result<i64> {
        Ok(self
            .db()?
            .query_row(
                "SELECT version FROM auto_order_strategy_stop WHERE strategyId = ?",
                [STRATEGY],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }

    pub fn heartbeat(&self, owner: &str, state: &str, now: i64) -> Result<bool> {
        Ok(self.db()?.execute(
            "UPDATE monitor_worker SET owner = ?, heartbeat = ?, state = ?
            WHERE key = 1 AND (owner = ? OR owner IS NULL OR heartbeat <= ?)",
            params![owner, now, state, owner, now - LEASE_MS],
        )? == 1)
    }

    pub fn release(&self, owner: &str) -> Result<()> {
        self.db()?.execute(
            "UPDATE monitor_worker SET owner = NULL, heartbeat = 0 WHERE owner = ?",
            [owner],
        )?;
        Ok(())
    }

    pub fn reset_watches(&self, owner: &str) -> Result<()> {
        self.db()?.execute(&format!("UPDATE auto_order_strategy_watch SET watch = json_set(watch, '$.status', 'stopped')
            WHERE {ACTIVE} AND EXISTS (SELECT 1 FROM monitor_worker WHERE key = 1 AND owner = ?)"), [owner])?;
        Ok(())
    }

    pub fn interrupt_spikes(&self, owner: &str) -> Result<()> {
        self.db()?.execute(
            "UPDATE monitor_spike SET status = 'interrupted' WHERE status = 'pending'
            AND EXISTS (SELECT 1 FROM monitor_worker WHERE key = 1 AND owner = ?)",
            [owner],
        )?;
        Ok(())
    }

    pub fn status(&self, now: i64) -> Result<Value> {
        let db = self.db()?;
        let rule = read_rule(&db)?;
        let worker: String = db.query_row("SELECT CASE WHEN owner IS NOT NULL AND heartbeat > ? THEN state ELSE 'offline' END FROM monitor_worker WHERE key = 1", [now - LEASE_MS], |row| row.get(0))?;
        let offline = worker == "offline";
        let records = query_json(&db, "SELECT json_object('id',id,'event',json(CASE
             WHEN ? AND json_extract(event,'$.breakoutObservation.status') = 'pending'
             THEN json_set(event,'$.breakoutObservation.status','interrupted') ELSE event END),'confirmedAt',confirmedAt,'delivery',delivery,
            'attempts',attempts,'lastAttempt',lastAttempt,'lastResult',lastResult)
            FROM monitor_alert AS alert WHERE NOT EXISTS (SELECT 1 FROM monitor_deleted_spike WHERE symbol = json_extract(alert.event, '$.symbol')
                AND time = json_extract(alert.event, '$.time') AND threshold = json_extract(alert.event, '$.threshold'))
            ORDER BY confirmedAt DESC, id DESC LIMIT 100", [offline])?;
        let spikes = query_json(&db, "SELECT json_set(event, '$.status', CASE WHEN ? AND status = 'pending' THEN 'interrupted' ELSE status END)
            FROM monitor_spike AS spike WHERE NOT EXISTS (SELECT 1 FROM monitor_deleted_spike WHERE id = spike.id)
            ORDER BY time DESC, id DESC LIMIT 100", [offline])?;
        let watches = query_json(&db, &format!("SELECT CASE WHEN ? AND {ACTIVE} THEN json_set(watch,'$.status','stopped') ELSE watch END
            FROM auto_order_strategy_watch WHERE {VISIBLE} ORDER BY CASE WHEN {ACTIVE} THEN 0 ELSE 1 END, time DESC
            LIMIT max(100, (SELECT COUNT(*) FROM auto_order_strategy_watch WHERE {VISIBLE} AND {ACTIVE}))"), [offline])?;
        let requests = query_json(&db, "SELECT json_object('id',id,'strategyId',strategyId,'symbol',symbol,'side',side,'amount',amount,'time',time)
            FROM (SELECT *,row_number() OVER (PARTITION BY strategyId ORDER BY time DESC,id DESC) AS rank FROM auto_order_request)
            WHERE rank <= 100 ORDER BY time DESC, id DESC", [])?;
        Ok(
            json!({"configured": rule.is_some(), "rule": rule.unwrap_or_default(), "worker": worker,
            "records": records, "spikes": spikes, "autoOrders": watches, "autoOrderRequests": requests}),
        )
    }

    pub fn record_spike(&self, event: &Value) -> Result<()> {
        self.db()?.execute("INSERT INTO monitor_spike VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET event = excluded.event, status = excluded.status",
            params![spike_id(event), event.to_string(), event["time"].as_i64(), event["status"].as_str()])?;
        Ok(())
    }

    pub fn delete_spikes(&self, spikes: &[Value]) -> Result<()> {
        let entries: Vec<_> = spikes
            .iter()
            .map(|spike| {
                json!([
                    spike_id(spike),
                    spike["symbol"],
                    spike["time"],
                    spike["threshold"]
                ])
            })
            .collect();
        self.db()?.execute("INSERT OR IGNORE INTO monitor_deleted_spike (id, symbol, time, threshold)
            SELECT json_extract(value, '$[0]'),json_extract(value, '$[1]'),json_extract(value, '$[2]'),json_extract(value, '$[3]') FROM json_each(?)",
            [serde_json::to_string(&entries)?])?;
        Ok(())
    }

    pub fn delete_watches(&self, watches: &[Value]) -> Result<()> {
        self.db()?.execute("UPDATE auto_order_strategy_watch SET watch = json_set(watch, '$.deleted', 1)
            WHERE (symbol,strategyId,time) IN (SELECT json_extract(value,'$.symbol'),json_extract(value,'$.strategy.id'),
                json_extract(value,'$.time') FROM json_each(?))", [serde_json::to_string(watches)?])?;
        Ok(())
    }

    pub fn confirm(
        &self,
        id: &str,
        event: &Value,
        rule: Rule,
        owner: &str,
        version: i64,
        now: i64,
    ) -> Result<bool> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if read_rule(&tx)? != Some(rule) {
            return Ok(false);
        }
        let signal = json!({"strategy": {"id": STRATEGY, "name": MARKET_SPIKE_NAME}, "symbol": event["symbol"], "time": event["time"]});
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO monitor_alert (id,event,confirmedAt,delivery,nextAttempt)
            SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM monitor_worker WHERE key=1 AND owner=?)
            AND COALESCE((SELECT version FROM auto_order_strategy_stop WHERE strategyId=?),0)=?",
            params![
                id,
                event.to_string(),
                now,
                if rule.notify { "queued" } else { "disabled" },
                now,
                owner,
                STRATEGY,
                version
            ],
        )? == 1;
        if inserted {
            tx.execute(
                "INSERT INTO auto_order_signal VALUES (?,?)",
                params![id, signal.to_string()],
            )?;
        }
        tx.commit()?;
        Ok(inserted)
    }

    pub fn signals(&self) -> Result<Vec<Value>> {
        query_json(&*self.db()?, "SELECT json_object('id',id,'signal',json(signal)) FROM auto_order_signal ORDER BY rowid LIMIT 100", [])
    }

    pub fn finish_signal(&self, id: &str, owner: &str) -> Result<()> {
        self.db()?.execute("DELETE FROM auto_order_signal WHERE id=? AND EXISTS (SELECT 1 FROM monitor_worker WHERE key=1 AND owner=?)", [id,owner])?;
        Ok(())
    }

    pub fn save_watch(&self, watch: &Value, owner: &str, version: i64) -> Result<()> {
        self.db()?.execute("INSERT INTO auto_order_strategy_watch (symbol,strategyId,watch,time)
            SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM monitor_worker WHERE key=1 AND owner=?)
            AND COALESCE((SELECT version FROM auto_order_strategy_stop WHERE strategyId=?),0)=?
            ON CONFLICT(symbol,strategyId) DO UPDATE SET watch = CASE
              WHEN auto_order_strategy_watch.time=excluded.time AND json_extract(auto_order_strategy_watch.watch,'$.deleted')=1
              THEN json_set(excluded.watch,'$.deleted',1) ELSE excluded.watch END,time=excluded.time
            WHERE auto_order_strategy_watch.time <= excluded.time", params![watch["symbol"].as_str(), STRATEGY, watch.to_string(), watch["time"].as_i64(), owner, STRATEGY, version])?;
        Ok(())
    }

    pub fn save_context(&self, id: &str, context: &Value) -> Result<()> {
        self.db()?.execute(
            "UPDATE monitor_alert SET event=json_set(event,'$.context',json(?)) WHERE id=?",
            params![context.to_string(), id],
        )?;
        Ok(())
    }

    pub fn round_alert(&self, round_id: &str, before: Option<i64>) -> Result<Option<Value>> {
        let sql = if before.is_some() {
            "SELECT event FROM monitor_alert WHERE json_extract(event,'$.roundId')=?1
                AND json_extract(event,'$.time') < ?2 ORDER BY json_extract(event,'$.time') DESC LIMIT 1"
        } else {
            "SELECT event FROM monitor_alert WHERE json_extract(event,'$.roundId')=?1
                AND ?2 IS NULL ORDER BY json_extract(event,'$.time') ASC LIMIT 1"
        };
        let value: Option<String> = self.db()?.query_row(sql, params![round_id, before], |row| row.get(0)).optional()?;
        value.map(|value| serde_json::from_str(&value).map_err(Into::into)).transpose()
    }

    pub fn save_round_quietness(&self, round_id: &str, quietness: &Value) -> Result<()> {
        self.db()?.execute("UPDATE monitor_alert SET event=json_set(event,'$.quietness',json(?2))
            WHERE id=(SELECT id FROM monitor_alert WHERE json_extract(event,'$.roundId')=?1
                ORDER BY json_extract(event,'$.time') ASC LIMIT 1)
            AND json_type(event,'$.quietness') IS NULL", params![round_id, quietness.to_string()])?;
        Ok(())
    }

    pub fn save_interval_turnover(&self, round_id: &str, time: i64, total: f64) -> Result<()> {
        self.db()?.execute("UPDATE monitor_alert SET event=json_set(event,'$.intervalTurnover',?3)
            WHERE json_extract(event,'$.roundId')=?1 AND json_extract(event,'$.time')=?2",
            params![round_id, time, total])?;
        Ok(())
    }

    pub fn finish_breakout_observation(&self, id: &str, owner: &str, observation: &Value) -> Result<()> {
        self.db()?.execute("UPDATE monitor_alert SET event = json_set(event, '$.breakoutObservation', json(?))
            WHERE id = ? AND json_extract(event, '$.breakoutObservation.status') = 'pending'
            AND EXISTS (SELECT 1 FROM monitor_worker WHERE key = 1 AND owner = ?)",
            params![observation.to_string(), id, owner])?;
        Ok(())
    }

    pub fn interrupt_breakout_observations(&self, owner: &str) -> Result<()> {
        self.db()?.execute("UPDATE monitor_alert SET event = json_set(event, '$.breakoutObservation.status', 'interrupted')
            WHERE json_extract(event, '$.breakoutObservation.status') = 'pending'
            AND EXISTS (SELECT 1 FROM monitor_worker WHERE key = 1 AND owner = ?)", [owner])?;
        Ok(())
    }

    pub fn allow_spike_order(
        &self, id: &str, owner: &str, rule: Rule, now: i64, claim: Option<&Value>,
    ) -> Result<bool> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !rule.enabled || !rule.continuation.auto_trade || read_rule(&tx)? != Some(rule) {
            return Ok(false);
        }
        let allowed: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM monitor_alert WHERE id = ?
            AND json_extract(event, '$.continuation.status') = 'pending'
            AND EXISTS (SELECT 1 FROM monitor_worker WHERE key = 1 AND owner = ? AND heartbeat > ?))",
            params![id, owner, now - LEASE_MS], |row| row.get(0))?;
        if let Some(result) = claim.filter(|_| allowed) {
            tx.execute("UPDATE monitor_alert SET event = json_set(event, '$.continuation', json(?)) WHERE id = ?",
                params![result.to_string(), id])?;
        }
        tx.commit()?;
        Ok(allowed)
    }

    pub fn finish_spike_evaluation(&self, id: &str, result: &Value) -> Result<()> {
        self.db()?.execute("UPDATE monitor_alert SET event = json_set(event, '$.continuation', json(?))
            WHERE id = ? AND json_extract(event, '$.continuation.status') IN ('pending', 'submitting')",
            params![result.to_string(), id])?;
        Ok(())
    }

    pub fn interrupt_spike_evaluations(&self, owner: &str, recover_submitting: bool) -> Result<()> {
        self.db()?.execute("UPDATE monitor_alert SET event = json_set(event, '$.continuation.status',
            CASE json_extract(event, '$.continuation.status') WHEN 'submitting' THEN 'unknown' ELSE 'interrupted' END)
            WHERE (json_extract(event, '$.continuation.status') = 'pending'
                OR (? AND json_extract(event, '$.continuation.status') = 'submitting'))
            AND EXISTS (SELECT 1 FROM monitor_worker WHERE key = 1 AND owner = ?)", params![recover_submitting, owner])?;
        Ok(())
    }

    pub fn claim_delivery(&self, now: i64) -> Result<Option<Delivery>> {
        let db = self.db()?;
        db.execute("UPDATE monitor_alert SET delivery='unknown',lastResult='unknown' WHERE delivery='sending' AND lastAttempt<=?", [now - 60_000])?;
        let row = db.query_row("UPDATE monitor_alert SET delivery='sending',attempts=attempts+1,lastAttempt=?
            WHERE id=(SELECT id FROM monitor_alert WHERE delivery='queued' AND nextAttempt<=? ORDER BY nextAttempt,confirmedAt LIMIT 1)
            RETURNING id,event,attempts", [now, now], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
            }).optional()?;
        row.map(|(id, event, attempts)| {
            Ok(Delivery {
                id,
                event: serde_json::from_str(&event)?,
                attempts,
            })
        })
        .transpose()
    }

    pub fn finish_delivery(&self, delivery: &Delivery, status: &str, now: i64) -> Result<()> {
        let retry = matches!(status, "failed" | "rate-limited" | "config-unavailable")
            && delivery.attempts < 3;
        self.db()?.execute("UPDATE monitor_alert SET delivery=?,nextAttempt=?,lastResult=? WHERE id=? AND attempts=? AND delivery='sending'",
            params![if retry {"queued"} else {status}, now + delivery.attempts * 60_000, status, delivery.id, delivery.attempts])?;
        Ok(())
    }

    /// Inserts or replaces one trade managed by the execution engine.
    pub fn save_trade(&self, trade: &Value) -> Result<()> {
        Self::write_trade(&*self.db()?, trade)
    }

    /// Serializes exchange changes even when the standalone monitor and web app share a database.
    pub fn begin_trade_operation(self: &Arc<Self>, trade_id: &str) -> Result<Option<TradeOperation>> {
        let owner = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let acquired = self.db()?.execute("INSERT INTO trade_operation VALUES (?, ?, ?)
            ON CONFLICT(tradeId) DO UPDATE SET owner = excluded.owner, expiresAt = excluded.expiresAt
            WHERE trade_operation.expiresAt <= ?", params![trade_id, owner, now + TRADE_OPERATION_MS, now])? == 1;
        if !acquired {
            return Ok(None);
        }
        let renewal = {
            let store = Arc::downgrade(self);
            let trade_id = trade_id.to_owned();
            let owner = owner.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(15)).await;
                    let Some(store) = store.upgrade() else { break; };
                    let updated = store.db().and_then(|db| Ok(db.execute(
                        "UPDATE trade_operation SET expiresAt = ? WHERE tradeId = ? AND owner = ?",
                        params![now_ms() + TRADE_OPERATION_MS, trade_id, owner],
                    )?));
                    if matches!(updated, Ok(0)) { break; }
                }
            })
        };
        Ok(Some(TradeOperation { store: Arc::clone(self), trade_id: trade_id.to_owned(), owner, renewal }))
    }

    pub fn reserve_trade(&self, trade: &Value, check: impl FnOnce(&[Value]) -> Result<()>) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        check(&Self::read_active_trades(&tx)?)?;
        Self::write_trade(&tx, trade)?;
        tx.commit()?;
        Ok(())
    }

    fn write_trade(db: &Connection, trade: &Value) -> Result<()> {
        let id = trade["id"].as_str().ok_or("trade id missing")?;
        let symbol = trade["symbol"].as_str().ok_or("trade symbol missing")?;
        let status = trade["status"].as_str().ok_or("trade status missing")?;
        let opened_at = trade["openedAt"].as_i64().ok_or("trade time missing")?;
        db.execute(
            "INSERT INTO trade VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
                symbol = excluded.symbol, status = excluded.status, data = excluded.data",
            params![id, symbol, status, opened_at, serde_json::to_string(trade)?],
        )?;
        Ok(())
    }

    /// Trades whose position may still exist on the exchange.
    pub fn active_trades(&self) -> Result<Vec<Value>> {
        Self::read_active_trades(&*self.db()?)
    }

    fn read_active_trades(db: &Connection) -> Result<Vec<Value>> {
        query_json(
            db,
            "SELECT data FROM trade WHERE status IN ('opening', 'open', 'closing') ORDER BY openedAt",
            [],
        )
    }

    pub fn trade(&self, id: &str) -> Result<Option<Value>> {
        Ok(query_json(&*self.db()?, "SELECT data FROM trade WHERE id = ?", [id])?
            .into_iter()
            .next())
    }

    pub fn recent_trades(&self, limit: i64) -> Result<Vec<Value>> {
        query_json(
            &*self.db()?,
            "SELECT data FROM trade ORDER BY CASE WHEN status IN ('opening', 'open', 'closing') THEN 0 ELSE 1 END,
                openedAt DESC LIMIT ?",
            [limit],
        )
    }

    /// Remove completed trades as one batch. A missing ID is safe to retry.
    pub fn delete_finished_trades(&self, ids: &[String]) -> Result<bool> {
        let ids = serde_json::to_string(ids)?;
        let mut db = self.db()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let blocked: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM trade WHERE id IN (SELECT value FROM json_each(?))
                AND (status NOT IN ('closed', 'failed') OR EXISTS (
                    SELECT 1 FROM trade_operation WHERE tradeId = trade.id AND expiresAt > ?)))",
            params![ids, now_ms()],
            |row| row.get(0),
        )?;
        if blocked {
            return Ok(false);
        }
        tx.execute(
            "DELETE FROM trade WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('closed', 'failed')",
            [&ids],
        )?;
        tx.commit()?;
        Ok(true)
    }

    pub fn prune(&self, now: i64) -> Result<()> {
        let db = self.db()?;
        let cutoff = now - RETENTION_MS;
        db.execute(
            "DELETE FROM monitor_alert WHERE confirmedAt < ? AND delivery != 'sending'",
            [cutoff],
        )?;
        db.execute("DELETE FROM monitor_spike WHERE time < ?", [cutoff])?;
        db.execute("DELETE FROM monitor_deleted_spike AS deleted WHERE time < ? AND NOT EXISTS (SELECT 1 FROM monitor_alert
            WHERE json_extract(event,'$.symbol')=deleted.symbol AND json_extract(event,'$.time')=deleted.time
            AND json_extract(event,'$.threshold')=deleted.threshold)", [cutoff])?;
        db.execute(
            &format!("DELETE FROM auto_order_strategy_watch WHERE time < ? AND NOT ({ACTIVE})"),
            [cutoff],
        )?;
        db.execute("DELETE FROM auto_order_request WHERE time < ?", [cutoff])?;
        db.execute("DELETE FROM auto_order_signal WHERE NOT EXISTS (SELECT 1 FROM monitor_alert WHERE id=auto_order_signal.id)", [])?;
        db.execute("DELETE FROM trade_operation WHERE expiresAt <= ?", [now])?;
        Ok(())
    }
}

fn read_rule(db: &Connection) -> Result<Option<Rule>> {
    let saved: Option<String> = db
        .query_row("SELECT value FROM monitor_rule WHERE key = 1", [], |row| {
            row.get(0)
        })
        .optional()?;
    let Some(saved) = saved else {
        return Ok(None);
    };
    let rule: Rule = serde_json::from_str(&saved)?;
    Ok(Some(rule.restore_saved()))
}

fn query_json(db: &Connection, sql: &str, params: impl rusqlite::Params) -> Result<Vec<Value>> {
    let mut query = db.prepare_cached(sql)?;
    let rows = query.query_map(params, |row| row.get::<_, String>(0))?;
    rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
}

pub fn spike_id(event: &Value) -> String {
    format!(
        "{}:{}:{}",
        event["symbol"].as_str().unwrap_or_default(),
        event["time"].as_i64().unwrap_or_default(),
        event["threshold"].as_f64().unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deletes_finished_trades_atomically_and_accepts_a_retry() {
        let store = Store::open_memory().unwrap();
        for phase in ["opening", "open", "closing", "closed", "failed"] {
            store.save_trade(&json!({
                "id": phase, "symbol": "BTCUSDT", "status": phase, "openedAt": 1
            })).unwrap();
        }
        assert!(!store.delete_finished_trades(&["closed".into(), "open".into()]).unwrap());
        assert!(store.trade("closed").unwrap().is_some());
        let selection = ["failed".into(), "closed".into()];
        assert!(store.delete_finished_trades(&selection).unwrap());
        assert!(store.delete_finished_trades(&selection).unwrap());
        assert!(store.trade("closed").unwrap().is_none());
        assert!(store.trade("failed").unwrap().is_none());
        assert_eq!(store.recent_trades(100).unwrap().len(), 3);
        assert_eq!(store.active_trades().unwrap().len(), 3);
    }

    #[test]
    fn reads_legacy_rule_with_current_alert_limits() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let mut rule = Rule {
            up: Some(130.0),
            down: None,
            turnover_multiple: 1.25,
            ..Rule::default()
        };
        store.save_rule(rule).unwrap();
        let restored = store.rule().unwrap();
        assert_eq!(restored.up, Some(100.0));
        assert_eq!(restored.down, None);
        assert_eq!(restored.turnover_multiple, 2.0);
        assert!(restored.is_valid());
        rule.turnover_multiple = 120.0;
        store.save_rule(rule).unwrap();
        assert_eq!(store.rule().unwrap().turnover_multiple, 100.0);
    }

    #[test]
    fn old_rule_json_keeps_its_directions_and_auto_trade_starts_off() {
        let old: Rule = serde_json::from_value(json!({
            "enabled":true,"notify":false,"up":null,"down":-5,"seconds":30,"turnoverMultiple":3
        })).unwrap();
        assert_eq!(old.up, None);
        assert!(old.is_valid());
        assert_eq!(serde_json::to_value(old.observation).unwrap(), json!({"minutes":15,"upPercent":3.0,"downPercent":3.0}));
        assert!(!old.continuation.auto_trade);
        assert_eq!(old.continuation.lookback_hours, 24);
        assert_eq!(old.continuation.max_range_percent, 5.0);
        assert_eq!(old.continuation.turnover_multiple, 5.0);
        assert_eq!(old.continuation.stop_loss_percent, 1.0);
        assert_eq!(old.continuation.take_profit_percent, 1.0);
    }

    #[test]
    fn first_round_quietness_is_immutable_and_previous_turnover_is_selected_by_time() {
        let store = Store::open_memory().unwrap();
        for (id, time, level) in [("first", 1000, 3), ("upgrade", 2000, 5), ("later", 3000, 6)] {
            let event = json!({"roundId":"round","time":time,"level":level,"volume":{"turnover":100}});
            store.db().unwrap().execute(
                "INSERT INTO monitor_alert(id,event,confirmedAt,delivery,nextAttempt) VALUES(?,?,0,'disabled',0)",
                params![id,event.to_string()]).unwrap();
        }
        store.save_round_quietness("round", &json!({"points":25,"start":0,"end":900})).unwrap();
        store.save_round_quietness("round", &json!({"points":0})).unwrap();
        assert_eq!(store.round_alert("round", None).unwrap().unwrap()["quietness"]["points"], 25);
        store.save_interval_turnover("round", 2000, 222.0).unwrap();
        let previous = store.round_alert("round", Some(3000)).unwrap().unwrap();
        assert_eq!(previous["level"], 5);
        assert_eq!(previous["intervalTurnover"], 222.0);
        assert_eq!(store.round_alert("round", Some(2000)).unwrap().unwrap()["level"], 3);
        assert!(store.round_alert("round", Some(1000)).unwrap().is_none());
    }

    #[test]
    fn saves_independent_observation_settings_with_the_monitor_rule() {
        let store = Store::open_memory().unwrap();
        let rule = Rule {
            observation: crate::strategy::ObservationRule { minutes: 22, up_percent: 3.25, down_percent: 7.0 },
            ..Rule::default()
        };
        store.save_rule(rule).unwrap();
        assert_eq!(store.rule().unwrap(), rule);
        assert_eq!(store.status(1_000).unwrap()["rule"]["observation"], json!({"minutes":22,"upPercent":3.25,"downPercent":7.0}));
    }

    #[test]
    fn a_rejected_reservation_does_not_create_an_opening_trade() {
        let store = Store::open_memory().unwrap();
        let first = json!({"id":"first","symbol":"BTCUSDT","status":"opening","openedAt":1});
        store.reserve_trade(&first, |active| {
            assert!(active.is_empty());
            Ok(())
        }).unwrap();
        let second = json!({"id":"second","symbol":"BTCUSDT","status":"opening","openedAt":2});
        assert!(store.reserve_trade(&second, |active| {
            assert_eq!(active, &[first]);
            Err("already opening".into())
        }).is_err());
        assert!(store.trade("second").unwrap().is_none());
    }

    #[tokio::test]
    async fn an_operation_lease_prevents_another_connection_from_changing_or_deleting_the_trade() {
        let path = std::env::temp_dir().join(format!("playground-lease-{}.sqlite", uuid::Uuid::new_v4()));
        let first = Arc::new(Store::open(&path).unwrap());
        let second = Arc::new(Store::open(&path).unwrap());
        first.save_trade(&json!({"id":"first","symbol":"BTCUSDT","status":"closed","openedAt":1})).unwrap();
        let lease = first.begin_trade_operation("first").unwrap().unwrap();
        assert!(second.begin_trade_operation("first").unwrap().is_none());
        assert!(!second.delete_finished_trades(&["first".into()]).unwrap());
        drop(lease);
        assert!(second.begin_trade_operation("first").unwrap().is_some());
        assert!(second.delete_finished_trades(&["first".into()]).unwrap());
        drop(first);
        drop(second);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_signal_can_be_claimed_once_and_disarming_interrupts_unclaimed_signals() {
        let store = Store::open_memory().unwrap();
        let mut rule = Rule { enabled: true, ..Rule::default() };
        rule.continuation.auto_trade = true;
        store.save_rule(rule).unwrap();
        store.heartbeat("owner", "connected", 5_000).unwrap();
        let pending = json!({"symbol":"BTCUSDT","time":5000,"threshold":5,"change":5,"continuation":{"status":"pending"}});
        assert!(store.confirm("first", &pending, rule, "owner", 0, 5_000).unwrap());
        let submitting = json!({"status":"submitting","score": {"total":80}});
        assert!(!store.allow_spike_order("first", "other", rule, 5_000, Some(&submitting)).unwrap());
        assert!(store.allow_spike_order("first", "owner", rule, 5_000, Some(&submitting)).unwrap());
        assert!(!store.allow_spike_order("first", "owner", rule, 5_000, Some(&submitting)).unwrap());
        assert!(store.confirm("second", &pending, rule, "owner", 0, 5_000).unwrap());
        store.disable_auto_trade().unwrap();
        store.save_rule(rule).unwrap();
        assert!(!store.allow_spike_order("second", "owner", rule, 5_000, Some(&submitting)).unwrap());
        store.interrupt_spike_evaluations("owner", true).unwrap();
        let status = store.status(5_000).unwrap();
        assert_eq!(status["records"][0]["event"]["continuation"]["status"], "interrupted");
        assert_eq!(status["records"][1]["event"]["continuation"]["status"], "unknown");
    }

    #[test]
    fn breakout_observations_and_order_scores_persist_independently() {
        let store = Store::open_memory().unwrap();
        let rule = Rule { enabled: true, ..Rule::default() };
        store.save_rule(rule).unwrap();
        assert!(store.heartbeat("owner", "connected", 5_000).unwrap());
        let pending = json!({"symbol":"BTCUSDT","time":5000,"threshold":5,
            "continuation":{"status":"pending"},"breakoutObservation":{"status":"pending"}});
        assert!(store.confirm("first", &pending, rule, "owner", 0, 5_000).unwrap());
        let observed = json!({"status":"ready","position":"held"});
        store.finish_breakout_observation("first", "another owner", &observed).unwrap();
        assert_eq!(store.status(5_000).unwrap()["records"][0]["event"]["breakoutObservation"]["status"], "pending");
        store.finish_breakout_observation("first", "owner", &observed).unwrap();
        let score = json!({"status":"below-score","score":{"total":30}});
        store.finish_spike_evaluation("first", &score).unwrap();
        let status = store.status(5_000).unwrap();
        let saved = &status["records"][0]["event"];
        assert_eq!(saved["breakoutObservation"], observed);
        assert_eq!(saved["continuation"], score);

        assert!(store.confirm("second", &pending, rule, "owner", 0, 5_001).unwrap());
        store.interrupt_breakout_observations("owner").unwrap();
        store.finish_breakout_observation("second", "owner", &observed).unwrap();
        let status = store.status(5_001).unwrap();
        assert_eq!(status["records"][0]["event"]["breakoutObservation"]["status"], "interrupted");
        assert_eq!(status["records"][1]["event"]["breakoutObservation"], observed);
    }

    #[test]
    fn disable_discards_signals_and_prevents_a_stale_worker_from_reopening_a_watch() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let mut rule = Rule {
            enabled: true,
            ..Rule::default()
        };
        let event = json!({"symbol":"BTCUSDT","time":5000,"threshold":-5,"change":-5});
        store.save_rule(rule).unwrap();
        assert!(store.heartbeat("owner", "connected", 5_000).unwrap());
        assert!(!store.heartbeat("another owner", "idle", 5_001).unwrap());
        assert!(store
            .confirm("confirmed", &event, rule, "owner", 0, 5_000)
            .unwrap());
        assert_eq!(store.signals().unwrap().len(), 1);
        rule.enabled = false;
        store.save_rule(rule).unwrap();
        assert_eq!(store.stop_version().unwrap(), 1);
        assert!(store.signals().unwrap().is_empty());
        let watch = json!({"symbol":"BTCUSDT","time":5000,"status":"starting"});
        store.save_watch(&watch, "owner", 0).unwrap();
        assert_eq!(store.status(5_000).unwrap()["autoOrders"], json!([]));
        store.delete_spikes(&[event]).unwrap();
        assert_eq!(store.status(5_000).unwrap()["records"], json!([]));
    }
}
