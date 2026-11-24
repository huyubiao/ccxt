use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

use crate::strategy::{Rule, MARKET_SPIKE_NAME};

const ACTIVE: &str = "json_extract(watch, '$.status') IN ('starting', 'watching')";
const VISIBLE: &str = "json_extract(watch, '$.deleted') IS NULL";
const STRATEGY: &str = "market-spike";
const LEASE_MS: i64 = 15_000;
const RETENTION_MS: i64 = 30 * 86_400_000;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub struct Store(Mutex<Connection>);

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

    fn open(path: &Path) -> Result<Self> {
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
        Ok(Self(Mutex::new(db)))
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
        let mut records = query_json(&db, "SELECT json_object('id',id,'event',json(event),'confirmedAt',confirmedAt,'delivery',delivery,
            'attempts',attempts,'lastAttempt',lastAttempt,'lastResult',lastResult)
            FROM monitor_alert AS alert WHERE NOT EXISTS (SELECT 1 FROM monitor_deleted_spike WHERE symbol = json_extract(alert.event, '$.symbol')
                AND time = json_extract(alert.event, '$.time') AND threshold = json_extract(alert.event, '$.threshold'))
            ORDER BY confirmedAt DESC, id DESC LIMIT 100", [])?;
        for record in &mut records {
            let event = &mut record["event"];
            if event["forecastDirection"].is_null() {
                event["forecastDirection"] =
                    json!(if event["change"].as_f64().unwrap_or(0.0) > 0.0 {
                        "up"
                    } else {
                        "down"
                    });
            }
        }
        let offline = worker == "offline";
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
