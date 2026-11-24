CREATE TABLE IF NOT EXISTS monitor_rule (key INTEGER PRIMARY KEY CHECK (key = 1), value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS monitor_worker (
    key INTEGER PRIMARY KEY CHECK (key = 1), owner TEXT, heartbeat INTEGER NOT NULL, state TEXT NOT NULL
);
INSERT OR IGNORE INTO monitor_worker VALUES (1, NULL, 0, 'idle');
CREATE TABLE IF NOT EXISTS monitor_alert (
    id TEXT PRIMARY KEY, event TEXT NOT NULL, confirmedAt INTEGER NOT NULL,
    delivery TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lastAttempt INTEGER, lastResult TEXT,
    nextAttempt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS monitor_alert_time ON monitor_alert (confirmedAt);
CREATE INDEX IF NOT EXISTS monitor_alert_queue ON monitor_alert (delivery, nextAttempt);
CREATE TABLE IF NOT EXISTS monitor_spike (id TEXT PRIMARY KEY, event TEXT NOT NULL, time INTEGER NOT NULL, status TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS monitor_spike_time ON monitor_spike (time);
CREATE TABLE IF NOT EXISTS monitor_deleted_spike (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, time INTEGER NOT NULL, threshold REAL NOT NULL);
CREATE INDEX IF NOT EXISTS monitor_deleted_spike_identity ON monitor_deleted_spike (symbol, time, threshold);
CREATE TABLE IF NOT EXISTS auto_order_signal (id TEXT PRIMARY KEY, signal TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auto_order_strategy_stop (strategyId TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auto_order_request (
    strategyId TEXT NOT NULL, symbol TEXT NOT NULL, id TEXT NOT NULL, side TEXT NOT NULL, amount REAL NOT NULL,
    time INTEGER NOT NULL, PRIMARY KEY (strategyId, symbol, id)
);
CREATE INDEX IF NOT EXISTS auto_order_request_time ON auto_order_request (strategyId, time DESC);
CREATE TABLE IF NOT EXISTS trade (
    id TEXT PRIMARY KEY, symbol TEXT NOT NULL, status TEXT NOT NULL, openedAt INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trade_status ON trade (status);
CREATE INDEX IF NOT EXISTS trade_time ON trade (openedAt);
