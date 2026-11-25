//! 统一执行与风控。
//!
//! 策略只产出下单意图（[`OrderIntent`]），由这里统一完成：
//! 风控检查 → 市价开仓 → 在交易所挂止损/止盈条件单 → 到期市价平仓 → 记录。
//! 所有策略的成交都写入 `trade` 表，并在页面的「下单记录」里展示。
//!
//! 本机账号设置优先于环境变量：
//! - `off`（默认）：不下单。
//! - `demo`：币安模拟盘（Demo Trading，demo-fapi.binance.com），使用模拟盘 API Key。
//! - `live`：币安实盘，必须额外设置确认变量，单笔金额上限默认更低。

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use ccxt_pro::exchange::ExchangeRuntime;
use ccxt_pro::exchange_generated::ExchangeBase;
use ccxt_pro::exchanges::binanceusdm::BinanceusdmCore;
use ccxt_pro::{runtime::call_typed, Config, Value as ExchangeValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{watch, Mutex, RwLock};
use uuid::Uuid;

use crate::binance::{number, outbound_proxy, Binance};
use crate::now_ms;
use crate::store::Store;

pub const LIVE_CONFIRMATION: &str = "YES_I_UNDERSTAND_REAL_MONEY";
const CHECK_INTERVAL: Duration = Duration::from_secs(5);
const BALANCE_CACHE_MS: i64 = 15_000;
const EXECUTION_RETRY_MS: i64 = 60_000;
pub(crate) const HISTORY_LIMIT: i64 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Off,
    Demo,
    Live,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Long,
    Short,
}

impl Side {
    fn entry(self) -> &'static str {
        match self {
            Side::Long => "buy",
            Side::Short => "sell",
        }
    }

    fn exit(self) -> &'static str {
        match self {
            Side::Long => "sell",
            Side::Short => "buy",
        }
    }

    fn position_side(self) -> &'static str {
        match self {
            Side::Long => "LONG",
            Side::Short => "SHORT",
        }
    }

    fn opposite(self) -> Self {
        match self {
            Side::Long => Side::Short,
            Side::Short => Side::Long,
        }
    }

    /// +1 for long, -1 for short: the sign of profit per unit of price increase.
    fn sign(self) -> f64 {
        match self {
            Side::Long => 1.0,
            Side::Short => -1.0,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountConfig {
    mode: Mode,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    api_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    secret: String,
    #[serde(default)]
    confirm_live: bool,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum AccountChange {
    Login {
        #[serde(flatten)]
        config: AccountConfig,
    },
    Logout {
        #[serde(rename = "accountRevision")]
        account_revision: String,
    },
}

pub struct Settings {
    pub mode: Mode,
    pub max_notional: f64,
    pub max_open_trades: usize,
    pub max_leverage: u32,
    /// Why trading is unavailable even though a mode was requested.
    pub problem: Option<String>,
    api_key: String,
    secret: String,
}

impl Settings {
    pub fn from_env() -> Self {
        Self::from_lookup(|key| std::env::var(key).ok().filter(|value| !value.trim().is_empty()))
    }

    pub fn load(path: &Path) -> Self {
        match std::fs::read(path) {
            Ok(content) => match serde_json::from_slice::<AccountConfig>(&content) {
                Ok(account) => Self::from_account(&account),
                Err(_) => Self::unreadable_account(),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Self::from_env(),
            Err(_) => Self::unreadable_account(),
        }
    }

    fn unreadable_account() -> Self {
        let mut settings = Self::from_lookup(|_| None);
        settings.problem = Some("无法读取保存的币安账号设置，请重新配置。".into());
        settings
    }

    fn from_account(account: &AccountConfig) -> Self {
        Self::from_lookup(|key| match key {
            "PLAYGROUND_TRADING_MODE" => Some(match account.mode {
                Mode::Off => "off",
                Mode::Demo => "demo",
                Mode::Live => "live",
            }.into()),
            "BINANCE_DEMO_API_KEY" | "BINANCE_API_KEY" => Some(account.api_key.clone()).filter(|key| !key.is_empty()),
            "BINANCE_DEMO_API_SECRET" | "BINANCE_API_SECRET" => Some(account.secret.clone()).filter(|secret| !secret.is_empty()),
            "PLAYGROUND_LIVE_TRADING_CONFIRM" => account.confirm_live.then(|| LIVE_CONFIRMATION.into()),
            _ => std::env::var(key).ok(),
        })
    }

    fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        let requested = get("PLAYGROUND_TRADING_MODE")
            .map(|mode| mode.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "off".into());
        let (mode, key_name, secret_name, default_notional) = match requested.as_str() {
            "demo" => (Mode::Demo, "BINANCE_DEMO_API_KEY", "BINANCE_DEMO_API_SECRET", 200.0),
            "live" => (Mode::Live, "BINANCE_API_KEY", "BINANCE_API_SECRET", 20.0),
            _ => (Mode::Off, "", "", 0.0),
        };
        let positive = |name: &str, fallback: f64| {
            get(name)
                .and_then(|value| value.trim().parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value > 0.0)
                .unwrap_or(fallback)
        };
        let mut settings = Self {
            mode,
            max_notional: positive("PLAYGROUND_MAX_ORDER_NOTIONAL", default_notional),
            max_open_trades: positive("PLAYGROUND_MAX_OPEN_TRADES", 3.0) as usize,
            max_leverage: (positive("PLAYGROUND_MAX_LEVERAGE", 5.0) as u32).clamp(1, 20),
            problem: None,
            api_key: String::new(),
            secret: String::new(),
        };
        if mode == Mode::Off {
            if requested != "off" {
                settings.problem = Some(format!(
                    "PLAYGROUND_TRADING_MODE={requested} 无效，只能是 off、demo 或 live。"
                ));
            }
            return settings;
        }
        match (get(key_name), get(secret_name)) {
            (Some(key), Some(secret)) => {
                settings.api_key = key.trim().to_owned();
                settings.secret = secret.trim().to_owned();
            }
            _ => settings.problem = Some(format!("缺少 {key_name} 或 {secret_name}。")),
        }
        if mode == Mode::Live && get("PLAYGROUND_LIVE_TRADING_CONFIRM").as_deref() != Some(LIVE_CONFIRMATION) {
            settings.problem = Some(format!(
                "实盘需要设置 PLAYGROUND_LIVE_TRADING_CONFIRM={LIVE_CONFIRMATION}。"
            ));
        }
        settings
    }

    fn enabled(&self) -> bool {
        self.mode != Mode::Off && self.problem.is_none()
    }
}

/// What a strategy asks the execution engine to do. Strategies never talk to the
/// exchange directly; adding a strategy means producing one of these.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderIntent {
    pub strategy_id: String,
    pub strategy_name: String,
    /// Binance contract id, e.g. `BTCUSDT`.
    pub symbol: String,
    pub side: Side,
    /// Position size in USDT at entry.
    pub notional: f64,
    pub leverage: u32,
    /// Price distance from entry, in percent (e.g. 1.5 means 1.5%).
    pub stop_loss_percent: f64,
    pub take_profit_percent: f64,
    pub max_hold_seconds: u64,
    pub note: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub filled: f64,
    pub quote: f64,
}

impl Execution {
    fn average(&self) -> f64 {
        self.quote / self.filled
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeOrder {
    /// entry | stop-loss | take-profit | exit
    pub kind: String,
    pub side: String,
    pub amount: f64,
    pub trigger_price: Option<f64>,
    pub exchange_id: Option<String>,
    pub average: Option<f64>,
    pub execution: Option<Execution>,
    /// placed | filled | canceled | triggered | failed
    pub status: String,
    pub error: Option<String>,
    pub time: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trade {
    pub id: String,
    pub strategy: StrategyRef,
    pub mode: Mode,
    pub symbol: String,
    pub unified_symbol: String,
    pub side: Side,
    #[serde(default)]
    pub hedged: bool,
    #[serde(default)]
    account_fingerprint: Option<String>,
    pub amount: f64,
    pub notional: f64,
    pub leverage: u32,
    pub entry_price: Option<f64>,
    pub stop_loss: Option<f64>,
    pub take_profit: Option<f64>,
    pub stop_loss_percent: f64,
    pub take_profit_percent: f64,
    pub deadline: i64,
    /// opening | open | closing | closed | failed
    pub status: String,
    pub opened_at: i64,
    pub closed_at: Option<i64>,
    pub exit_price: Option<f64>,
    pub exit_reason: Option<String>,
    pub error: Option<String>,
    pub note: String,
    pub orders: Vec<TradeOrder>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StrategyRef {
    pub id: String,
    pub name: String,
}

impl Trade {
    fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    fn public_value(&self) -> Value {
        public_trade(self.to_value())
    }

    fn order_id(&self, kind: &str) -> Option<String> {
        self.orders
            .iter()
            .rev()
            .find(|order| order.kind == kind && order.status == "placed")
            .and_then(|order| order.exchange_id.clone())
    }

    fn mark_order(&mut self, kind: &str, status: &str) {
        if let Some(order) = self
            .orders
            .iter_mut()
            .rev()
            .find(|order| order.kind == kind && order.status == "placed")
        {
            order.status = status.into();
        }
    }

    fn order_needs_execution(&self, order: &TradeOrder) -> bool {
        order.execution.is_none() && order.exchange_id.is_some()
            && matches!(order.status.as_str(), "filled" | "triggered" | "placed")
            && (matches!(order.kind.as_str(), "entry" | "exit")
                || matches!(self.status.as_str(), "closed" | "failed"))
    }
}

type TradeResult<T> = Result<T, String>;

fn public_trade(mut trade: Value) -> Value {
    if let Some(record) = trade.as_object_mut() {
        record.remove("accountFingerprint");
    }
    trade
}

struct Account {
    settings: Settings,
    exchange: Option<Mutex<BinanceusdmCore>>,
    revision: Uuid,
    fingerprint: Option<String>,
}

impl Account {
    fn new(settings: Settings) -> Self {
        let exchange = settings.enabled().then(|| Mutex::new(trading_client(&settings)));
        let fingerprint = exchange.as_ref().map(|_| format!("{:x}", Sha256::digest(settings.api_key.as_bytes())));
        Self { settings, exchange, revision: Uuid::new_v4(), fingerprint }
    }

    fn matches_key(&self, fingerprint: Option<&str>) -> bool {
        fingerprint.is_none_or(|value| self.fingerprint.as_deref() == Some(value))
    }
}

pub struct Trader {
    account: RwLock<Account>,
    store: Arc<Store>,
    market_data: Arc<Binance>,
    /// Serializes submit / close / periodic checks so one trade is never handled twice.
    operations: Mutex<()>,
    balance: Mutex<Option<(i64, Value)>>,
    execution_attempts: Mutex<HashMap<String, i64>>,
}

impl Trader {
    pub fn new(settings: Settings, store: Arc<Store>, market_data: Arc<Binance>) -> Self {
        Self {
            account: RwLock::new(Account::new(settings)),
            store,
            market_data,
            operations: Mutex::new(()),
            balance: Mutex::new(None),
            execution_attempts: Mutex::new(HashMap::new()),
        }
    }

    pub async fn change_account(&self, change: AccountChange) -> TradeResult<()> {
        let _operation = self.operations.lock().await;
        let mut account = self.account.write().await;
        let config = match change {
            AccountChange::Login { mut config } => {
                if account.settings.enabled() {
                    return Err("已登录币安账号，请先登出再登录其他账号。".into());
                }
                if config.mode == Mode::Off {
                    return Err("登录时请选择模拟盘或实盘。".into());
                }
                config.api_key = config.api_key.trim().to_owned();
                config.secret = config.secret.trim().to_owned();
                if config.api_key.len() > 256 || config.secret.len() > 256 {
                    return Err("API Key 或 Secret 格式无效。".into());
                }
                config
            }
            AccountChange::Logout { account_revision } => {
                if Uuid::parse_str(&account_revision).ok() != Some(account.revision) {
                    return Err("币安账号状态已变化，请刷新后重试。".into());
                }
                AccountConfig {
                    mode: Mode::Off, api_key: String::new(), secret: String::new(), confirm_live: false,
                }
            }
        };
        let settings = Settings::from_account(&config);
        if let Some(problem) = &settings.problem {
            return Err(problem.clone());
        }
        if !self.store.active_trades().map_err(|_| "无法读取进行中的交易。")?.is_empty() {
            return Err("还有进行中的策略交易，结束后才能登录或登出币安账号。".into());
        }
        let next = Account::new(settings);
        if let Some(exchange) = &next.exchange {
            let mut core = exchange.lock().await;
            require_hedge_mode(&mut core).await?;
        }
        crate::store::write_private_json(&self.store.trading_account_path(), &config)
            .map_err(|_| "无法保存币安账号设置。")?;
        *account = next;
        self.invalidate_balance().await;
        Ok(())
    }

    /// Account summary and recent trades for the page.
    pub async fn status(&self) -> Value {
        let trades: Vec<_> = self.store.recent_trades(HISTORY_LIMIT).unwrap_or_default()
            .into_iter().map(public_trade).collect();
        let account = self.account.read().await;
        let settings = &account.settings;
        json!({
            "mode": settings.mode,
            "accountRevision": account.revision.to_string(),
            "enabled": settings.enabled(),
            "problem": settings.problem,
            "limits": {
                "maxNotional": settings.max_notional,
                "maxOpenTrades": settings.max_open_trades,
                "maxLeverage": settings.max_leverage,
            },
            "balance": self.balance(account.exchange.as_ref()).await,
            "trades": trades,
        })
    }

    pub async fn delete_finished_trades(&self, ids: &[String]) -> crate::store::Result<bool> {
        let _operation = self.operations.lock().await;
        self.store.delete_finished_trades(ids)
    }

    async fn balance(&self, exchange: Option<&Mutex<BinanceusdmCore>>) -> Value {
        let Some(exchange) = exchange else {
            return Value::Null;
        };
        let mut cache = self.balance.lock().await;
        if let Some((time, value)) = cache.as_ref() {
            if now_ms() - time < BALANCE_CACHE_MS {
                return value.clone();
            }
        }
        // Do not wait behind an order that is being placed; show the last known value.
        let Ok(mut core) = exchange.try_lock() else {
            return cache.as_ref().map(|(_, value)| value.clone()).unwrap_or(Value::Null);
        };
        let rows = call_typed(core.fapi_private_v3_get_balance(&[ExchangeValue::from_json(&json!({}))]))
            .await
            .map(|value| value.to_json());
        drop(core);
        let value = match rows {
            Ok(Value::Array(rows)) => rows
                .iter()
                .find(|row| row["asset"] == "USDT")
                .map(|row| {
                    json!({
                        "asset": "USDT",
                        "available": number(&row["availableBalance"]),
                        "total": number(&row["balance"]),
                        "unrealizedPnl": number(&row["crossUnPnl"]),
                        "time": now_ms(),
                    })
                })
                .unwrap_or(json!({"error": "账户中没有 USDT 余额。"})),
            Ok(_) => json!({"error": "无法解析账户余额。"}),
            Err(error) => json!({"error": readable(&error)}),
        };
        *cache = Some((now_ms(), value.clone()));
        value
    }

    /// Places a trade for a strategy: risk checks, market entry, exchange-side
    /// stop-loss and take-profit. Returns the stored trade.
    pub async fn submit(&self, intent: OrderIntent, account_revision: Uuid) -> TradeResult<Value> {
        let _operation = self.operations.lock().await;
        let account = self.account.read().await;
        if account_revision != account.revision {
            return Err("币安账号设置已更新，请核对当前账号后重新确认下单。".into());
        }
        let settings = &account.settings;
        let Some(exchange) = &account.exchange else {
            return Err(settings
                .problem
                .clone()
                .unwrap_or_else(|| "交易未开启，请在「账号设置」中连接币安。".into()));
        };
        Self::check_intent(settings, &intent)?;
        let active = self.store.active_trades().map_err(|_| "无法读取进行中的交易。")?;
        let account_trades = active.iter().filter(|trade| trade["mode"] == json!(settings.mode)
            && account.matches_key(trade["accountFingerprint"].as_str()));
        if account_trades.clone().count() >= settings.max_open_trades {
            return Err(format!(
                "进行中的交易已达上限 {} 笔（PLAYGROUND_MAX_OPEN_TRADES）。",
                settings.max_open_trades
            ));
        }
        if account_trades.clone().any(|trade| blocks_entry(trade, &intent)) {
            return Err(format!("{} 已有同方向或旧单向持仓的策略交易。", intent.symbol));
        }
        let contract = self
            .market_data
            .contract(&intent.symbol)
            .await
            .map_err(|_| "无法读取币安合约列表，请稍后重试。")?
            .ok_or_else(|| format!("{} 不是可交易的币安 USDT 永续合约。", intent.symbol))?;
        let unified = format!("{}/{}:{}", contract.base, contract.quote, contract.quote);

        let mut core = exchange.lock().await;
        call_typed(core.load_markets(&[ExchangeValue::Bool(false)]))
            .await
            .map_err(|error| format!("加载交易所市场失败：{}", readable(&error)))?;
        let market = ccxt_pro::get_value(&core.markets, &ExchangeValue::from(unified.as_str())).to_json();
        if market.is_null() {
            return Err(format!("交易客户端中找不到 {unified}。"));
        }

        require_hedge_mode(&mut core).await?;
        let positions = position_rows(&mut core, &intent.symbol).await?;
        if position_value(&positions, &intent.symbol, intent.side.position_side(), "positionAmt").abs() > 0.0 {
            return Err(format!(
                "{} 在交易所已有同方向持仓，本次不下单。",
                intent.symbol
            ));
        }
        let opposite = intent.side.opposite().position_side();
        let opposite_orders = check_open_orders(&mut core, &intent.symbol, intent.side).await?;
        let shared_leverage = account_trades.clone().any(|trade| trade["symbol"] == intent.symbol.as_str())
            || position_value(&positions, &intent.symbol, opposite, "positionAmt").abs() > 0.0
            || opposite_orders;
        let mark = mark_price(&mut core, &intent.symbol).await?;
        let amount = order_amount(&core, &unified, &market, intent.notional, mark)?;

        set_entry_leverage(&mut core, &intent, shared_leverage).await?;

        let now = now_ms();
        let mut trade = Trade {
            id: Uuid::new_v4().to_string(),
            strategy: StrategyRef {
                id: intent.strategy_id.clone(),
                name: intent.strategy_name.clone(),
            },
            mode: settings.mode,
            symbol: intent.symbol.clone(),
            unified_symbol: unified.clone(),
            side: intent.side,
            hedged: true,
            account_fingerprint: account.fingerprint.clone(),
            amount,
            notional: amount * mark,
            leverage: intent.leverage,
            entry_price: None,
            stop_loss: None,
            take_profit: None,
            stop_loss_percent: intent.stop_loss_percent,
            take_profit_percent: intent.take_profit_percent,
            deadline: now + intent.max_hold_seconds as i64 * 1_000,
            status: "opening".into(),
            opened_at: now,
            closed_at: None,
            exit_price: None,
            exit_reason: None,
            error: None,
            note: intent.note.clone(),
            orders: Vec::new(),
        };
        self.save(&trade)?;

        let client_id = format!("pg-{}", Uuid::new_v4().simple());
        let entry = place(
            &mut core,
            &unified,
            intent.side.entry(),
            amount,
            json!({"newClientOrderId": &client_id[..client_id.len().min(36)], "positionSide": intent.side.position_side()}),
        )
        .await;
        let entry = match entry {
            Ok(order) => order,
            Err(error) => {
                trade.status = "failed".into();
                trade.error = Some(format!("开仓失败：{error}"));
                trade.closed_at = Some(now_ms());
                trade.orders.push(failed_order("entry", intent.side.entry(), amount, None, &error));
                self.save(&trade)?;
                return Err(trade.error.clone().unwrap_or_default());
            }
        };
        let entry_record = order_record("entry", intent.side.entry(), amount, None, &entry, "filled");
        let entry_price = match entry_record.average {
            Some(price) => price,
            None => position_rows(&mut core, &intent.symbol).await.ok()
                .map(|rows| position_value(&rows, &intent.symbol, intent.side.position_side(), "entryPrice"))
                .filter(|price| *price > 0.0).unwrap_or(mark),
        };
        let amount = entry_record.execution.as_ref().map_or(amount, |execution| execution.filled);
        trade.entry_price = entry_record.average;
        if let Some(execution) = &entry_record.execution {
            trade.amount = execution.filled;
            trade.notional = execution.quote;
        }
        trade.orders.push(entry_record);
        let sign = intent.side.sign();
        let stop_loss = entry_price * (1.0 - sign * intent.stop_loss_percent / 100.0);
        let take_profit = entry_price * (1.0 + sign * intent.take_profit_percent / 100.0);
        trade.stop_loss = Some(stop_loss);
        trade.take_profit = Some(take_profit);
        trade.status = "open".into();
        self.save(&trade)?;

        // Protect the position on the exchange so it survives a crash of this service.
        let mut protection_error = None;
        for (kind, key, price) in [
            ("stop-loss", "stopLossPrice", stop_loss),
            ("take-profit", "takeProfitPrice", take_profit),
        ] {
            let params = json!({key: price, "positionSide": intent.side.position_side(), "workingType": "MARK_PRICE"});
            match place(&mut core, &unified, intent.side.exit(), amount, params).await {
                Ok(order) => trade
                    .orders
                    .push(order_record(kind, intent.side.exit(), amount, Some(price), &order, "placed")),
                Err(error) => {
                    trade
                        .orders
                        .push(failed_order(kind, intent.side.exit(), amount, Some(price), &error));
                    protection_error = Some(format!("{kind} 条件单下单失败：{error}"));
                    break;
                }
            }
        }
        self.save(&trade)?;
        if let Some(error) = protection_error {
            // Never leave an unprotected position behind.
            self.close_locked(&mut core, &mut trade, "保护单失败，已市价平仓").await;
            if trade.status == "closed" {
                trade.status = "failed".into();
            }
            trade.error = Some(trade.error.as_ref().map_or_else(|| error.clone(), |close| format!("{error}；{close}")));
            self.save(&trade)?;
            return Err(error);
        }
        drop(core);
        self.invalidate_balance().await;
        Ok(trade.public_value())
    }

    fn check_intent(settings: &Settings, intent: &OrderIntent) -> TradeResult<()> {
        if !intent.notional.is_finite() || intent.notional <= 0.0 {
            return Err("下单金额必须大于 0。".into());
        }
        if intent.notional > settings.max_notional {
            return Err(format!(
                "下单金额 {} USDT 超过单笔上限 {} USDT（PLAYGROUND_MAX_ORDER_NOTIONAL）。",
                intent.notional, settings.max_notional
            ));
        }
        if intent.leverage < 1 || intent.leverage > settings.max_leverage {
            return Err(format!("杠杆必须在 1 到 {} 倍之间。", settings.max_leverage));
        }
        if !(0.1..=20.0).contains(&intent.stop_loss_percent) {
            return Err("止损幅度必须在 0.1% 到 20% 之间。".into());
        }
        // The stop must trigger before liquidation; keep a margin below 1/leverage.
        if intent.stop_loss_percent >= 80.0 / intent.leverage as f64 {
            return Err(format!(
                "{} 倍杠杆下止损幅度必须小于 {:.2}%，否则可能先被强平。",
                intent.leverage,
                80.0 / intent.leverage as f64
            ));
        }
        if !(0.1..=50.0).contains(&intent.take_profit_percent) {
            return Err("止盈幅度必须在 0.1% 到 50% 之间。".into());
        }
        if !(60..=86_400).contains(&intent.max_hold_seconds) {
            return Err("最长持仓时间必须在 1 分钟到 24 小时之间。".into());
        }
        if !crate::routes::valid_symbol(&intent.symbol) {
            return Err("交易对格式无效。".into());
        }
        Ok(())
    }

    /// Manually closes one open trade at market.
    pub async fn close(&self, id: &str) -> TradeResult<Value> {
        let _operation = self.operations.lock().await;
        let account = self.account.read().await;
        let Some(exchange) = &account.exchange else {
            return Err("交易未开启。".into());
        };
        let mut trade = self.load(id)?;
        if trade.mode != account.settings.mode || !account.matches_key(trade.account_fingerprint.as_deref()) {
            return Err("请用这笔交易原来的账户处理平仓。".into());
        }
        if !matches!(trade.status.as_str(), "opening" | "open" | "closing") {
            return Err("这笔交易已经结束。".into());
        }
        let mut core = exchange.lock().await;
        self.close_locked(&mut core, &mut trade, "手动平仓").await;
        drop(core);
        self.invalidate_balance().await;
        if trade.status == "closing" {
            return Err(trade.error.unwrap_or_else(|| "平仓尚未完成。".into()));
        }
        Ok(trade.public_value())
    }

    /// One pass over active trades: detect exchange-side exits and close expired trades.
    pub async fn check(&self) {
        let _operation = self.operations.lock().await;
        let account = self.account.read().await;
        let Some(exchange) = &account.exchange else {
            return;
        };
        let Ok(active) = self.store.active_trades() else {
            return;
        };
        for row in active {
            let Ok(mut trade) = serde_json::from_value::<Trade>(row) else {
                continue;
            };
            if trade.mode != account.settings.mode || !account.matches_key(trade.account_fingerprint.as_deref()) {
                // A trade from the other account cannot be managed with these keys.
                continue;
            }
            let mut core = exchange.lock().await;
            let Ok(position) = trade_position(&mut core, &trade).await else {
                continue;
            };
            if position.abs() == 0.0 {
                if trade.status == "opening" && trade.orders.is_empty() {
                    trade.status = "failed".into();
                    trade.error = Some("服务在开仓过程中中断，交易所没有对应持仓。".into());
                    trade.closed_at = Some(now_ms());
                    let _ = self.save(&trade);
                    continue;
                }
                self.finish_exchange_exit(&mut core, &mut trade).await;
            } else if trade.status == "closing" || now_ms() >= trade.deadline {
                self.close_locked(&mut core, &mut trade, "持仓到期，市价平仓").await;
            }
        }
        drop(_operation);
    }

    /// The position is gone: one of the protective orders fired (or it was closed by hand).
    async fn finish_exchange_exit(&self, core: &mut BinanceusdmCore, trade: &mut Trade) {
        cancel_trigger(core, trade, "stop-loss").await;
        cancel_trigger(core, trade, "take-profit").await;
        trade.status = "closed".into();
        trade.exit_reason = Some("仓位已在交易所平掉（来源待核实）".into());
        trade.closed_at = Some(now_ms());
        let _ = self.save(trade);
    }

    /// Cancels the protective orders and closes whatever position remains.
    async fn close_locked(&self, core: &mut BinanceusdmCore, trade: &mut Trade, reason: &str) {
        trade.status = "closing".into();
        let _ = self.save(trade);
        cancel_trigger(core, trade, "stop-loss").await;
        cancel_trigger(core, trade, "take-profit").await;
        let remaining = match trade_position(core, trade).await {
            Ok(amount) => amount,
            Err(error) => {
                trade.error = Some(format!("平仓前读取持仓失败：{error}"));
                let _ = self.save(trade);
                return;
            }
        };
        if remaining.abs() > 0.0 {
            let (side, amount, params) = closing_order(trade, remaining);
            match place(core, &trade.unified_symbol, side, amount, params).await {
                Ok(order) => {
                    let exit = order_record("exit", side, amount, None, &order, "filled");
                    trade.exit_price = exit.average;
                    trade.orders.push(exit);
                }
                Err(error) => {
                    trade.orders.push(failed_order("exit", side, amount, None, &error));
                    trade.error = Some(format!("平仓失败，请到币安手动处理：{error}"));
                    let _ = self.save(trade);
                    return;
                }
            }
        }
        trade.status = "closed".into();
        trade.exit_reason = Some(reason.into());
        trade.closed_at = Some(now_ms());
        let _ = self.save(trade);
    }

    fn load(&self, id: &str) -> TradeResult<Trade> {
        let value = self
            .store
            .trade(id)
            .map_err(|_| "无法读取交易记录。")?
            .ok_or("找不到这笔交易。")?;
        serde_json::from_value(value).map_err(|_| "交易记录格式无效。".into())
    }

    fn save(&self, trade: &Trade) -> TradeResult<()> {
        self.store
            .save_trade(&trade.to_value())
            .map_err(|error| format!("保存交易记录失败：{error}"))
    }

    async fn invalidate_balance(&self) {
        *self.balance.lock().await = None;
    }

    /// Read-only reconciliation of one incomplete trade per pass. Both the
    /// mode and account key must match the recorded trade.
    async fn refresh_executions(&self) {
        let Ok(_operation) = self.operations.try_lock() else { return; };
        let account = self.account.read().await;
        let Some(exchange) = &account.exchange else { return; };
        let Ok(rows) = self.store.recent_trades(HISTORY_LIMIT) else { return; };
        let mut attempts = self.execution_attempts.lock().await;
        let now = now_ms();
        attempts.retain(|_, time| now - *time < 30 * EXECUTION_RETRY_MS);
        let Some(mut trade) = rows.into_iter()
            .filter_map(|row| serde_json::from_value::<Trade>(row).ok())
            .filter(|trade| trade.mode == account.settings.mode
                && account.matches_key(trade.account_fingerprint.as_deref())
                && attempts.get(&trade.id).is_none_or(|last| now - *last >= EXECUTION_RETRY_MS)
                && trade.orders.iter().any(|order| trade.order_needs_execution(order)))
            .min_by_key(|trade| attempts.get(&trade.id).copied().unwrap_or_default())
        else { return; };
        let Ok(mut core) = exchange.try_lock() else { return; };
        attempts.insert(trade.id.clone(), now);
        drop(attempts);
        let deadline = tokio::time::Instant::now() + CHECK_INTERVAL;
        let mut changed = false;
        for index in 0..trade.orders.len() {
            let order = &trade.orders[index];
            if !trade.order_needs_execution(order) {
                continue;
            }
            let result = tokio::time::timeout_at(deadline, fetch_execution(&mut core, &trade, order)).await;
            let Ok(execution) = result else { break; };
            let Some(execution) = execution else { continue; };
            let order = &mut trade.orders[index];
            order.average = Some(execution.average());
            if order.kind == "entry" {
                trade.entry_price = order.average;
            } else if order.kind == "exit" {
                trade.exit_price = order.average;
            } else {
                order.status = "triggered".into();
                trade.exit_price = order.average;
                if trade.exit_reason.as_deref().is_some_and(|reason| reason.contains("来源")) {
                    trade.exit_reason = Some(if order.kind == "stop-loss" { "止损触发" } else { "止盈触发" }.into());
                }
            }
            order.execution = Some(execution);
            changed = true;
        }
        if changed {
            let _ = self.save(&trade);
        }
    }
}

/// Background loop: checks active trades every few seconds until shutdown.
pub async fn supervise(trader: Arc<Trader>, mut stop: watch::Receiver<bool>) {
    while !*stop.borrow() {
        trader.check().await;
        trader.refresh_executions().await;
        tokio::select! {
            _ = tokio::time::sleep(CHECK_INTERVAL) => {},
            _ = stop.changed() => {},
        }
    }
}

fn trading_client(settings: &Settings) -> BinanceusdmCore {
    let mut config = Config::new()
        .api_key(&settings.api_key)
        .secret(&settings.secret)
        .timeout_ms(10_000)
        .enable_rate_limit(true)
        // Futures-only keys: skip the spot wallet currency list (sapi).
        .option_bool("fetchCurrencies", false);
    if let Some(proxy) = outbound_proxy() {
        config = config.set_str("httpsProxy", &proxy);
    }
    let mut core = BinanceusdmCore::new(config.into_option());
    if settings.mode == Mode::Demo {
        core.parent.enable_demo_trading(ExchangeValue::Bool(true));
    }
    core
}

/// Turns an exchange error into a short message for the page.
fn readable(error: &ccxt_pro::ExchangeError) -> String {
    let message = error.message.trim();
    // Binance errors look like `binanceusdm {"code":-2019,"msg":"Margin is insufficient."}`.
    if let Some(start) = message.find('{') {
        if let Ok(body) = serde_json::from_str::<Value>(&message[start..]) {
            if let Some(text) = body["msg"].as_str() {
                return match body["code"].as_i64() {
                    Some(code) => format!("{text}（{code}）"),
                    None => text.to_owned(),
                };
            }
        }
    }
    error.kind.clone()
}

fn empty() -> ExchangeValue {
    ExchangeValue::from_json(&json!({}))
}

async fn typed(future: impl std::future::Future<Output = ExchangeValue>) -> TradeResult<ExchangeValue> {
    call_typed(future).await.map_err(|error| readable(&error))
}

async fn place(
    core: &mut BinanceusdmCore,
    symbol: &str,
    side: &str,
    amount: f64,
    params: Value,
) -> TradeResult<Value> {
    let order = call_typed(core.create_order(
        ExchangeValue::from(symbol),
        ExchangeValue::from("market"),
        ExchangeValue::from(side),
        ExchangeValue::Float(amount),
        &[ExchangeValue::Null, ExchangeValue::from_json(&params)],
    ))
    .await
    .map_err(|error| readable(&error))?;
    Ok(order.to_json())
}

/// Cancels one protective order. Returns false if it no longer exists (already triggered).
async fn cancel_trigger(core: &mut BinanceusdmCore, trade: &mut Trade, kind: &str) -> bool {
    let Some(id) = trade.order_id(kind) else {
        return true;
    };
    let result = call_typed(core.cancel_order(
        ExchangeValue::from(id.as_str()),
        &[
            ExchangeValue::from(trade.unified_symbol.as_str()),
            ExchangeValue::from_json(&json!({"trigger": true})),
        ],
    ))
    .await;
    match result {
        Ok(_) => {
            trade.mark_order(kind, "canceled");
            true
        }
        Err(_) => false,
    }
}

async fn position_rows(core: &mut BinanceusdmCore, symbol: &str) -> TradeResult<Vec<Value>> {
    let rows = typed(core
        .fapi_private_v3_get_position_risk(&[ExchangeValue::from_json(&json!({"symbol": symbol}))])).await?
        .to_json();
    match rows {
        Value::Array(rows) => Ok(rows),
        _ => Err("无法解析持仓数据。".into()),
    }
}

fn blocks_entry(trade: &Value, intent: &OrderIntent) -> bool {
    trade["symbol"] == intent.symbol.as_str()
        && (trade["hedged"] != true || trade["side"] == json!(intent.side))
}

fn position_value(rows: &[Value], symbol: &str, side: &str, field: &str) -> f64 {
    rows
        .iter()
        .find(|row| row["symbol"] == symbol && row["positionSide"] == side)
        .and_then(|row| number(&row[field]))
        .unwrap_or_default()
}

async fn trade_position(core: &mut BinanceusdmCore, trade: &Trade) -> TradeResult<f64> {
    let side = if trade.hedged { trade.side.position_side() } else { "BOTH" };
    Ok(position_value(&position_rows(core, &trade.symbol).await?, &trade.symbol, side, "positionAmt"))
}

fn closing_order(trade: &Trade, remaining: f64) -> (&'static str, f64, Value) {
    if trade.hedged {
        (trade.side.exit(), remaining.abs().min(trade.amount), json!({"positionSide": trade.side.position_side()}))
    } else {
        let order_side = if remaining > 0.0 { "sell" } else { "buy" };
        (order_side, remaining.abs(), json!({"reduceOnly": true}))
    }
}

async fn require_hedge_mode(core: &mut BinanceusdmCore) -> TradeResult<()> {
    let config = typed(core.fapi_private_get_position_side_dual(&[empty()])).await?.to_json();
    if config["dualSidePosition"] != true {
        return Err("请在币安 USDⓈ-M 合约设置中启用双向持仓。".into());
    }
    Ok(())
}

async fn check_open_orders(core: &mut BinanceusdmCore, symbol: &str, side: Side) -> TradeResult<bool> {
    let query = [ExchangeValue::from_json(&json!({"symbol": symbol}))];
    let orders = typed(core.fapi_private_get_open_orders(&query)).await?.to_json();
    let triggers = typed(core.fapi_private_get_open_algo_orders(&query)).await?.to_json();
    let orders = orders.as_array().ok_or("无法读取未成交订单。")?;
    let triggers = triggers.as_array().ok_or("无法读取未成交条件单。")?;
    let pending = orders.iter().chain(triggers);
    if pending.clone().any(|order| order["positionSide"] == side.position_side()) {
        return Err(format!("{symbol} 有同方向未成交订单，请核对后再下单。"));
    }
    Ok(pending.into_iter().any(|order| order["positionSide"] == side.opposite().position_side()))
}

async fn set_entry_leverage(core: &mut BinanceusdmCore, intent: &OrderIntent, shared: bool) -> TradeResult<()> {
    if shared {
        let query = [ExchangeValue::from_json(&json!({"symbol": intent.symbol}))];
        let config = typed(core.fapi_private_get_symbol_config(&query)).await?.to_json();
        let leverage = config.as_array()
            .and_then(|rows| rows.iter().find(|row| row["symbol"] == intent.symbol.as_str()))
            .and_then(|row| number(&row["leverage"]))
            .ok_or("无法核对合约当前杠杆。")?;
        if leverage != f64::from(intent.leverage) {
            return Err(format!("同一合约的多仓和空仓共用杠杆，请使用当前的 {leverage} 倍杠杆。"));
        }
    } else {
        typed(core.fapi_private_post_leverage(&[ExchangeValue::from_json(&json!({
            "symbol": intent.symbol, "leverage": intent.leverage
        }))])).await.map_err(|error| format!("设置杠杆失败：{error}"))?;
    }
    Ok(())
}

async fn mark_price(core: &mut BinanceusdmCore, symbol: &str) -> TradeResult<f64> {
    let quote = typed(core
        .fapi_public_get_premium_index(&[ExchangeValue::from_json(&json!({"symbol": symbol}))])).await?
        .to_json();
    number(&quote["markPrice"])
        .filter(|price| *price > 0.0)
        .ok_or_else(|| "无法读取标记价格。".into())
}

/// Converts a USDT notional to a contract amount that satisfies the market's
/// step size, minimum amount and minimum notional.
fn order_amount(
    core: &BinanceusdmCore,
    symbol: &str,
    market: &Value,
    notional: f64,
    price: f64,
) -> TradeResult<f64> {
    let raw_amount = notional / price;
    let precise = ccxt_pro::runtime::catch_typed(|| {
        ExchangeBase::amount_to_precision(core, ExchangeValue::from(symbol), ExchangeValue::Float(raw_amount))
    })
    .map(|value| value.to_json())
    .ok()
    .and_then(|value| number(&value))
    .unwrap_or(0.0);
    let min_amount = number(&market["limits"]["amount"]["min"]).unwrap_or(0.0);
    let min_cost = number(&market["limits"]["cost"]["min"]).unwrap_or(0.0);
    if precise <= 0.0 || precise < min_amount {
        return Err(format!(
            "{notional} USDT 换算后的数量低于最小下单数量 {min_amount}，请提高金额。"
        ));
    }
    if precise * price < min_cost {
        return Err(format!(
            "按数量精度截断后金额约 {:.2} USDT，低于最小下单金额 {min_cost} USDT，请提高金额。",
            precise * price
        ));
    }
    Ok(precise)
}

fn confirmed_execution(filled: &Value, quote: &Value, average: &Value) -> Option<Execution> {
    let filled = number(filled).filter(|value| *value > 0.0)?;
    let quote = number(quote).filter(|value| *value > 0.0)
        .or_else(|| number(average).map(|average| filled * average))
        .filter(|quote| quote.is_finite() && *quote > 0.0)?;
    Some(Execution { filled, quote })
}

fn binance_execution(order: &Value) -> Option<Execution> {
    if !matches!(order["status"].as_str(), Some("FILLED" | "CANCELED" | "EXPIRED" | "EXPIRED_IN_MATCH")) {
        return None;
    }
    confirmed_execution(&order["executedQty"], &order["cumQuote"], &order["avgPrice"])
}

fn order_id(value: &Value) -> Option<String> {
    let id = value.as_str().map(str::to_owned).or_else(|| value.as_u64().map(|id| id.to_string()))?;
    (!id.is_empty() && id.bytes().all(|digit| digit.is_ascii_digit()) && id.bytes().any(|digit| digit != b'0')).then_some(id)
}

async fn fetch_execution(core: &mut BinanceusdmCore, trade: &Trade, order: &TradeOrder) -> Option<Execution> {
    let mut id = order.exchange_id.clone()?;
    if order.kind == "stop-loss" || order.kind == "take-profit" {
        let request = [ExchangeValue::from_json(&json!({"algoId": id}))];
        let trigger = typed(core.fapi_private_get_algo_order(&request)).await.ok()?.to_json();
        id = order_id(&trigger["actualOrderId"])?;
    }
    let request = [ExchangeValue::from_json(&json!({"symbol": trade.symbol, "orderId": id}))];
    let execution = typed(core.fapi_private_get_order(&request)).await.ok()?.to_json();
    let position = if trade.hedged { trade.side.position_side() } else { "BOTH" };
    if execution["symbol"] != trade.symbol.as_str() || execution["positionSide"] != position
        || !execution["side"].as_str().is_some_and(|side| side.eq_ignore_ascii_case(&order.side))
    {
        return None;
    }
    binance_execution(&execution)
}

fn order_record(kind: &str, side: &str, amount: f64, trigger: Option<f64>, order: &Value, status: &str) -> TradeOrder {
    let execution = if trigger.is_some() {
        None
    } else {
        binance_execution(&order["info"]).or_else(|| {
            if order["status"] == "closed" {
                confirmed_execution(&order["filled"], &order["cost"], &order["average"])
            } else {
                None
            }
        })
    };
    TradeOrder {
        kind: kind.into(),
        side: side.into(),
        amount,
        trigger_price: trigger,
        exchange_id: order_id(&order["id"]),
        average: execution.as_ref().map(Execution::average),
        execution,
        status: status.into(),
        error: None,
        time: now_ms(),
    }
}

fn failed_order(kind: &str, side: &str, amount: f64, trigger: Option<f64>, error: &str) -> TradeOrder {
    TradeOrder {
        kind: kind.into(),
        side: side.into(),
        amount,
        trigger_price: trigger,
        exchange_id: None,
        average: None,
        execution: None,
        status: "failed".into(),
        error: Some(error.into()),
        time: now_ms(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn settings(values: &[(&str, &str)]) -> Settings {
        let map: HashMap<String, String> = values
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        Settings::from_lookup(|key| map.get(key).cloned())
    }

    #[test]
    fn trading_is_off_unless_a_mode_and_keys_are_configured() {
        assert!(!settings(&[]).enabled());
        let demo = settings(&[("PLAYGROUND_TRADING_MODE", "demo")]);
        assert_eq!(demo.mode, Mode::Demo);
        assert!(demo.problem.as_deref().unwrap().contains("BINANCE_DEMO_API_KEY"));
        let ready = settings(&[
            ("PLAYGROUND_TRADING_MODE", "demo"),
            ("BINANCE_DEMO_API_KEY", "k"),
            ("BINANCE_DEMO_API_SECRET", "s"),
        ]);
        assert!(ready.enabled());
        assert_eq!(ready.max_notional, 200.0);
    }

    #[test]
    fn live_trading_requires_explicit_confirmation_and_uses_lower_limit() {
        let keys = [
            ("PLAYGROUND_TRADING_MODE", "live"),
            ("BINANCE_API_KEY", "k"),
            ("BINANCE_API_SECRET", "s"),
        ];
        assert!(settings(&keys).problem.unwrap().contains(LIVE_CONFIRMATION));
        let mut confirmed = keys.to_vec();
        confirmed.push(("PLAYGROUND_LIVE_TRADING_CONFIRM", LIVE_CONFIRMATION));
        let live = settings(&confirmed);
        assert!(live.enabled());
        assert_eq!(live.max_notional, 20.0);
        // Demo keys must never be used for live trading.
        assert!(!settings(&[
            ("PLAYGROUND_TRADING_MODE", "live"),
            ("BINANCE_DEMO_API_KEY", "k"),
            ("BINANCE_DEMO_API_SECRET", "s"),
            ("PLAYGROUND_LIVE_TRADING_CONFIRM", LIVE_CONFIRMATION),
        ])
        .enabled());
    }

    #[test]
    fn demo_client_points_private_and_public_futures_calls_at_demo_hosts() {
        let client = trading_client(&settings(&[
            ("PLAYGROUND_TRADING_MODE", "demo"),
            ("BINANCE_DEMO_API_KEY", "k"),
            ("BINANCE_DEMO_API_SECRET", "s"),
        ]));
        let api = client.urls.to_json()["api"].clone();
        assert!(api["fapiPrivate"].as_str().unwrap().starts_with("https://demo-fapi.binance.com"));
        assert!(api["fapiPublic"].as_str().unwrap().starts_with("https://demo-fapi.binance.com"));
        let live = trading_client(&settings(&[
            ("PLAYGROUND_TRADING_MODE", "live"),
            ("BINANCE_API_KEY", "k"),
            ("BINANCE_API_SECRET", "s"),
        ]));
        assert!(live.urls.to_json()["api"]["fapiPrivate"]
            .as_str()
            .unwrap()
            .starts_with("https://fapi.binance.com"));
    }

    #[test]
    fn stop_loss_must_trigger_before_liquidation() {
        let trader_settings = settings(&[
            ("PLAYGROUND_TRADING_MODE", "demo"),
            ("BINANCE_DEMO_API_KEY", "k"),
            ("BINANCE_DEMO_API_SECRET", "s"),
            ("PLAYGROUND_MAX_LEVERAGE", "20"),
        ]);
        let mut intent = OrderIntent {
            strategy_id: "test".into(),
            strategy_name: "测试策略".into(),
            symbol: "BTCUSDT".into(),
            side: Side::Long,
            notional: 100.0,
            leverage: 20,
            stop_loss_percent: 5.0,
            take_profit_percent: 2.0,
            max_hold_seconds: 600,
            note: String::new(),
        };
        assert!(Trader::check_intent(&trader_settings, &intent).unwrap_err().contains("强平"));
        intent.stop_loss_percent = 2.0;
        assert!(Trader::check_intent(&trader_settings, &intent).is_ok());
        intent.notional = 1_000.0;
        assert!(Trader::check_intent(&trader_settings, &intent).unwrap_err().contains("上限"));
    }

    #[tokio::test]
    async fn a_changed_account_rejects_an_order_before_contacting_binance() {
        let trader = Trader::new(settings(&[]), Arc::new(Store::open_memory().unwrap()), Arc::new(Binance::new()));
        let intent = OrderIntent {
            strategy_id: "test".into(), strategy_name: "测试策略".into(), symbol: "BTCUSDT".into(),
            side: Side::Long, notional: 20.0, leverage: 2, stop_loss_percent: 1.0,
            take_profit_percent: 1.0, max_hold_seconds: 300, note: String::new(),
        };
        assert!(!blocks_entry(&json!({"symbol":"BTCUSDT","hedged":true,"side":"short"}), &intent));
        assert!(blocks_entry(&json!({"symbol":"BTCUSDT","hedged":true,"side":"long"}), &intent));
        assert!(blocks_entry(&json!({"symbol":"BTCUSDT","side":"short"}), &intent));
        let error = trader.submit(intent, Uuid::new_v4()).await.unwrap_err();
        assert!(error.contains("账号设置已更新"));
        let status = trader.status().await;
        assert!(!status.to_string().contains("apiKey"));
        assert!(!status.to_string().contains("secret"));
    }

    #[test]
    fn trades_round_trip_through_the_store() {
        let store = Store::open_memory().unwrap();
        let trade = Trade {
            id: "test-BTCUSDT-1".into(),
            strategy: StrategyRef { id: "test".into(), name: "测试策略".into() },
            mode: Mode::Demo,
            symbol: "BTCUSDT".into(),
            unified_symbol: "BTC/USDT:USDT".into(),
            side: Side::Short,
            hedged: true,
            account_fingerprint: Some("test fingerprint".into()),
            amount: 0.002,
            notional: 200.0,
            leverage: 3,
            entry_price: Some(100_000.0),
            stop_loss: Some(101_000.0),
            take_profit: Some(98_000.0),
            stop_loss_percent: 1.0,
            take_profit_percent: 2.0,
            deadline: 2,
            status: "open".into(),
            opened_at: 1,
            closed_at: None,
            exit_price: None,
            exit_reason: None,
            error: None,
            note: String::new(),
            orders: vec![],
        };
        store.save_trade(&trade.to_value()).unwrap();
        let active = store.active_trades().unwrap();
        assert_eq!(active.len(), 1);
        let loaded: Trade = serde_json::from_value(active[0].clone()).unwrap();
        assert!(loaded.public_value().get("accountFingerprint").is_none());
        assert_eq!(loaded.side, Side::Short);
        assert_eq!(loaded.mode, Mode::Demo);
        let (side, amount, params) = closing_order(&loaded, -0.004);
        assert_eq!((side, amount), ("buy", 0.002));
        assert_eq!(params, json!({"positionSide":"SHORT"}));
        let mut legacy = trade.to_value();
        legacy.as_object_mut().unwrap().remove("hedged");
        let legacy: Trade = serde_json::from_value(legacy).unwrap();
        assert!(!legacy.hedged);
        assert_eq!(closing_order(&legacy, -0.002).2, json!({"reduceOnly":true}));
    }

    #[test]
    fn hedge_position_selection_keeps_long_and_short_separate() {
        let rows = vec![
            json!({"symbol":"BTCUSDT","positionSide":"LONG","positionAmt":"0.01"}),
            json!({"symbol":"BTCUSDT","positionSide":"SHORT","positionAmt":"-0.01"}),
        ];
        assert_eq!(position_value(&rows, "BTCUSDT", "LONG", "positionAmt"), 0.01);
        assert_eq!(position_value(&rows, "BTCUSDT", "SHORT", "positionAmt"), -0.01);
        assert_eq!(position_value(&rows, "BTCUSDT", "BOTH", "positionAmt"), 0.0);
    }

    #[test]
    fn page_configuration_requires_specific_keys_and_live_confirmation() {
        let config = |value| serde_json::from_value::<AccountConfig>(value).unwrap();
        let live = config(json!({"mode":"live","apiKey":"key","secret":"secret"}));
        assert!(!Settings::from_account(&live).enabled());
        let demo = config(json!({"mode":"demo","apiKey":"key","secret":"secret"}));
        assert!(Settings::from_account(&demo).enabled());
        let missing = config(json!({"mode":"demo","apiKey":"key"}));
        assert!(!Settings::from_account(&missing).enabled());
    }

    #[tokio::test]
    async fn a_logged_in_account_rejects_reconfiguration_and_stale_logout() {
        let settings = settings(&[
            ("PLAYGROUND_TRADING_MODE", "demo"),
            ("BINANCE_DEMO_API_KEY", "fixture-key"),
            ("BINANCE_DEMO_API_SECRET", "fixture-secret"),
        ]);
        let trader = Trader::new(settings, Arc::new(Store::open_memory().unwrap()), Arc::new(Binance::new()));
        for mode in ["demo", "live"] {
            let login = serde_json::from_value(json!({
                "action": "login", "mode": mode, "apiKey": "new-key", "secret": "new-secret", "confirmLive": true,
            })).unwrap();
            assert!(trader.change_account(login).await.unwrap_err().contains("请先登出"));
        }
        let logout = AccountChange::Logout { account_revision: Uuid::new_v4().to_string() };
        assert!(trader.change_account(logout).await.unwrap_err().contains("状态已变化"));
        assert_eq!(trader.account.read().await.settings.api_key, "fixture-key");
    }

    #[tokio::test]
    async fn logout_clears_persisted_credentials_and_keeps_trading_off_after_restart() {
        let directory = std::env::temp_dir().join(format!("playground-logout-{}", Uuid::new_v4()));
        let database = directory.join("monitor.sqlite");
        let store = Arc::new(Store::open(&database).unwrap());
        let path = store.trading_account_path();
        crate::store::write_private_json(&path, &json!({
            "mode": "demo", "apiKey": "fixture-key", "secret": "fixture-secret",
        })).unwrap();
        let trader = Trader::new(Settings::load(&path), store, Arc::new(Binance::new()));
        let revision = trader.account.read().await.revision.to_string();
        trader.change_account(AccountChange::Logout {
            account_revision: revision,
        }).await.unwrap();
        let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["mode"], "off");
        assert!(saved.get("apiKey").is_none() && saved.get("secret").is_none());
        assert!(!Settings::load(&path).enabled());
        drop(trader);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_file(database).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn recorded_execution_uses_filled_quantity_and_current_order_quote() {
        let wire = json!({"status":"FILLED", "executedQty":"0.002", "cumQuote":"201.5", "avgPrice":"100750"});
        let execution = binance_execution(&wire).unwrap();
        assert_eq!(execution.filled, 0.002);
        assert_eq!(execution.quote, 201.5);
        assert_eq!(execution.average(), 100_750.0);
        let pending = json!({"status":"NEW","executedQty":"0","origQty":"0.002","price":"100750"});
        assert!(binance_execution(&pending).is_none());
        let protective = order_record("take-profit", "sell", 0.002, Some(101_000.0),
            &json!({"id":"789","price":101_000,"status":"open"}), "placed");
        assert!(protective.average.is_none() && protective.execution.is_none());
        assert_eq!(order_id(&json!("9876543210987654321")).as_deref(), Some("9876543210987654321"));
        assert!(order_id(&json!("")).is_none());
    }
}
