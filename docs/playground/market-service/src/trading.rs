//! 统一执行与风控。
//!
//! 策略只产出下单意图（[`OrderIntent`]），由这里统一完成：
//! 风控检查 → 市价开仓 → 在交易所挂止损/止盈条件单 → 到期市价平仓 → 记录。
//! 所有策略的成交都写入 `trade` 表，并在页面的「自动下单任务」里展示。
//!
//! 账户模式由环境变量决定，页面只能查看不能切换：
//! - `off`（默认）：不下单。
//! - `demo`：币安模拟盘（Demo Trading，demo-fapi.binance.com），使用模拟盘 API Key。
//! - `live`：币安实盘，必须额外设置确认变量，单笔金额上限默认更低。

use std::sync::Arc;
use std::time::Duration;

use ccxt_pro::exchange::ExchangeRuntime;
use ccxt_pro::exchange_generated::ExchangeBase;
use ccxt_pro::exchanges::binanceusdm::BinanceusdmCore;
use ccxt_pro::{runtime::call_typed, Config, Value as ExchangeValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{watch, Mutex};
use uuid::Uuid;

use crate::binance::{number, outbound_proxy, Binance};
use crate::now_ms;
use crate::store::Store;

pub const LIVE_CONFIRMATION: &str = "YES_I_UNDERSTAND_REAL_MONEY";
const CHECK_INTERVAL: Duration = Duration::from_secs(5);
const BALANCE_CACHE_MS: i64 = 15_000;
const HISTORY_LIMIT: i64 = 100;

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

    /// +1 for long, -1 for short: the sign of profit per unit of price increase.
    fn sign(self) -> f64 {
        match self {
            Side::Long => 1.0,
            Side::Short => -1.0,
        }
    }
}

/// Account and risk settings, read once at startup.
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
pub struct TradeOrder {
    /// entry | stop-loss | take-profit | exit
    pub kind: String,
    pub side: String,
    pub amount: f64,
    pub trigger_price: Option<f64>,
    pub exchange_id: Option<String>,
    pub average: Option<f64>,
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
}

type TradeResult<T> = Result<T, String>;

pub struct Trader {
    settings: Settings,
    store: Arc<Store>,
    market_data: Arc<Binance>,
    exchange: Option<Mutex<BinanceusdmCore>>,
    /// Serializes submit / close / periodic checks so one trade is never handled twice.
    operations: Mutex<()>,
    balance: Mutex<Option<(i64, Value)>>,
}

impl Trader {
    pub fn new(settings: Settings, store: Arc<Store>, market_data: Arc<Binance>) -> Self {
        let exchange = settings.enabled().then(|| Mutex::new(trading_client(&settings)));
        Self {
            settings,
            store,
            market_data,
            exchange,
            operations: Mutex::new(()),
            balance: Mutex::new(None),
        }
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    /// Account summary and recent trades for the page.
    pub async fn status(&self) -> Value {
        let trades = self.store.recent_trades(HISTORY_LIMIT).unwrap_or_default();
        json!({
            "mode": self.settings.mode,
            "enabled": self.settings.enabled(),
            "problem": self.settings.problem,
            "limits": {
                "maxNotional": self.settings.max_notional,
                "maxOpenTrades": self.settings.max_open_trades,
                "maxLeverage": self.settings.max_leverage,
            },
            "balance": self.balance().await,
            "trades": trades,
        })
    }

    async fn balance(&self) -> Value {
        let Some(exchange) = &self.exchange else {
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
    pub async fn submit(&self, intent: OrderIntent) -> TradeResult<Value> {
        let Some(exchange) = &self.exchange else {
            return Err(self
                .settings
                .problem
                .clone()
                .unwrap_or_else(|| "交易未开启：请设置 PLAYGROUND_TRADING_MODE=demo 或 live。".into()));
        };
        self.check_intent(&intent)?;
        let _operation = self.operations.lock().await;
        let active = self.store.active_trades().map_err(|_| "无法读取进行中的交易。")?;
        if active.len() >= self.settings.max_open_trades {
            return Err(format!(
                "进行中的交易已达上限 {} 笔（PLAYGROUND_MAX_OPEN_TRADES）。",
                self.settings.max_open_trades
            ));
        }
        if active.iter().any(|trade| trade["symbol"] == intent.symbol.as_str()) {
            return Err(format!("{} 已有进行中的交易，同一合约同一时间只允许一个策略持仓。", intent.symbol));
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

        let dual: Value = raw(typed(core.fapi_private_get_position_side_dual(&[empty()])).await?)?;
        if dual["dualSidePosition"] == true {
            return Err("账户处于双向持仓模式，请在币安合约设置中切换为单向持仓后再试。".into());
        }
        if position_amount(&mut core, &intent.symbol).await?.abs() > 0.0 {
            return Err(format!(
                "{} 在交易所已有持仓（可能是手动开的），为避免互相干扰，本次不下单。",
                intent.symbol
            ));
        }
        let mark = mark_price(&mut core, &intent.symbol).await?;
        let amount = order_amount(&core, &unified, &market, intent.notional, mark)?;

        raw(typed(core
            .fapi_private_post_leverage(&[ExchangeValue::from_json(&json!({"symbol": intent.symbol, "leverage": intent.leverage}))])).await?)
        .map_err(|error| format!("设置杠杆失败：{error}"))?;

        let now = now_ms();
        let mut trade = Trade {
            id: format!("{}-{}-{}", intent.strategy_id, intent.symbol, now),
            strategy: StrategyRef {
                id: intent.strategy_id.clone(),
                name: intent.strategy_name.clone(),
            },
            mode: self.settings.mode,
            symbol: intent.symbol.clone(),
            unified_symbol: unified.clone(),
            side: intent.side,
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
            json!({"newClientOrderId": &client_id[..client_id.len().min(36)]}),
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
        let entry_price = match number(&entry["average"]).filter(|price| *price > 0.0) {
            Some(price) => price,
            None => position_entry(&mut core, &intent.symbol).await.unwrap_or(mark),
        };
        trade.orders.push(order_record("entry", intent.side.entry(), amount, None, &entry, "filled"));
        trade.entry_price = Some(entry_price);
        trade.notional = amount * entry_price;
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
            let params = json!({key: price, "reduceOnly": true, "workingType": "MARK_PRICE"});
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
            trade.status = "failed".into();
            trade.error = Some(error.clone());
            self.save(&trade)?;
            return Err(error);
        }
        drop(core);
        self.invalidate_balance().await;
        Ok(trade.to_value())
    }

    fn check_intent(&self, intent: &OrderIntent) -> TradeResult<()> {
        let settings = &self.settings;
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
        let Some(exchange) = &self.exchange else {
            return Err("交易未开启。".into());
        };
        let _operation = self.operations.lock().await;
        let mut trade = self.load(id)?;
        if !matches!(trade.status.as_str(), "opening" | "open" | "closing") {
            return Err("这笔交易已经结束。".into());
        }
        let mut core = exchange.lock().await;
        self.close_locked(&mut core, &mut trade, "手动平仓").await;
        drop(core);
        self.invalidate_balance().await;
        Ok(trade.to_value())
    }

    /// One pass over active trades: detect exchange-side exits and close expired trades.
    pub async fn check(&self) {
        let Some(exchange) = &self.exchange else {
            return;
        };
        let _operation = self.operations.lock().await;
        let Ok(active) = self.store.active_trades() else {
            return;
        };
        for row in active {
            let Ok(mut trade) = serde_json::from_value::<Trade>(row) else {
                continue;
            };
            if trade.mode != self.settings.mode {
                // A trade from the other account cannot be managed with these keys.
                continue;
            }
            let mut core = exchange.lock().await;
            let Ok(position) = position_amount(&mut core, &trade.symbol).await else {
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
            } else if now_ms() >= trade.deadline {
                self.close_locked(&mut core, &mut trade, "持仓到期，市价平仓").await;
            }
        }
        drop(_operation);
    }

    /// The position is gone: one of the protective orders fired (or it was closed by hand).
    async fn finish_exchange_exit(&self, core: &mut BinanceusdmCore, trade: &mut Trade) {
        let stop_gone = !cancel_trigger(core, trade, "stop-loss").await;
        let profit_gone = !cancel_trigger(core, trade, "take-profit").await;
        let reason = match (stop_gone, profit_gone) {
            (true, false) => {
                trade.mark_order("stop-loss", "triggered");
                "止损触发"
            }
            (false, true) => {
                trade.mark_order("take-profit", "triggered");
                "止盈触发"
            }
            _ => "仓位已在交易所平掉（来源未知）",
        };
        trade.exit_price = match reason {
            "止损触发" => trade.stop_loss,
            "止盈触发" => trade.take_profit,
            _ => None,
        };
        trade.status = "closed".into();
        trade.exit_reason = Some(reason.into());
        trade.closed_at = Some(now_ms());
        let _ = self.save(trade);
    }

    /// Cancels the protective orders and closes whatever position remains.
    async fn close_locked(&self, core: &mut BinanceusdmCore, trade: &mut Trade, reason: &str) {
        trade.status = "closing".into();
        let _ = self.save(trade);
        cancel_trigger(core, trade, "stop-loss").await;
        cancel_trigger(core, trade, "take-profit").await;
        let remaining = match position_amount(core, &trade.symbol).await {
            Ok(amount) => amount,
            Err(error) => {
                trade.error = Some(format!("平仓前读取持仓失败：{error}"));
                let _ = self.save(trade);
                return;
            }
        };
        if remaining.abs() > 0.0 {
            let side = if remaining > 0.0 { "sell" } else { "buy" };
            match place(core, &trade.unified_symbol, side, remaining.abs(), json!({"reduceOnly": true})).await {
                Ok(order) => {
                    trade.exit_price = number(&order["average"]).filter(|price| *price > 0.0);
                    trade
                        .orders
                        .push(order_record("exit", side, remaining.abs(), None, &order, "filled"));
                }
                Err(error) => {
                    trade.orders.push(failed_order("exit", side, remaining.abs(), None, &error));
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
}

/// Background loop: checks active trades every few seconds until shutdown.
pub async fn supervise(trader: Arc<Trader>, mut stop: watch::Receiver<bool>) {
    if !trader.settings.enabled() {
        return;
    }
    while !*stop.borrow() {
        trader.check().await;
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
    if message.is_empty() {
        error.kind.clone()
    } else {
        format!("{}: {message}", error.kind)
    }
}

fn empty() -> ExchangeValue {
    ExchangeValue::from_json(&json!({}))
}

/// Raw endpoint responses arrive as exchange values; errors are already mapped.
fn raw(value: ExchangeValue) -> TradeResult<Value> {
    Ok(value.to_json())
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

/// Signed position size (positive long, negative short) in one-way mode.
async fn position_amount(core: &mut BinanceusdmCore, symbol: &str) -> TradeResult<f64> {
    Ok(position_rows(core, symbol)
        .await?
        .iter()
        .filter(|row| row["symbol"] == symbol)
        .filter_map(|row| number(&row["positionAmt"]))
        .sum())
}

async fn position_entry(core: &mut BinanceusdmCore, symbol: &str) -> TradeResult<f64> {
    position_rows(core, symbol)
        .await?
        .iter()
        .filter(|row| row["symbol"] == symbol)
        .find_map(|row| number(&row["entryPrice"]).filter(|price| *price > 0.0))
        .ok_or_else(|| "无法读取开仓均价。".into())
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

fn order_record(kind: &str, side: &str, amount: f64, trigger: Option<f64>, order: &Value, status: &str) -> TradeOrder {
    TradeOrder {
        kind: kind.into(),
        side: side.into(),
        amount,
        trigger_price: trigger,
        exchange_id: order["id"].as_str().map(str::to_owned),
        average: number(&order["average"]).filter(|price| *price > 0.0),
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
        let store = Arc::new(Store::open_memory().unwrap());
        let trader = Trader::new(trader_settings, store, Arc::new(Binance::new()));
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
        assert!(trader.check_intent(&intent).unwrap_err().contains("强平"));
        intent.stop_loss_percent = 2.0;
        assert!(trader.check_intent(&intent).is_ok());
        intent.notional = 1_000.0;
        assert!(trader.check_intent(&intent).unwrap_err().contains("上限"));
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
        assert_eq!(loaded.side, Side::Short);
        assert_eq!(loaded.mode, Mode::Demo);
    }
}
