use ccxt_pro::exchange::ExchangeRuntime;
use ccxt_pro::runtime::call_typed;
use ccxt_pro::Value as ExchangeValue;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use super::{
    binance_execution, execution_uncertain, mark_price, minimum_order_amount, order_amount,
    order_id, order_record, place_market, position_rows, position_value, readable, typed, Account,
    BinanceusdmCore, Execution, OrderIntent, OrderSize, RoundIncrease, RoundOrder, Trade,
    TradeResult, Trader, ENTRY_RECOVERY_GRACE_MS, LIMIT_EXIT,
};
use crate::now_ms;

const ADD_ENTRY: &str = "add-entry";

impl Trade {
    fn pending_increase(&self) -> Option<usize> {
        self.orders
            .iter()
            .position(|order| order.kind == ADD_ENTRY && order.status == "placed")
    }

    fn record_increase(&mut self, index: usize, execution: Execution) {
        self.amount += execution.filled;
        self.notional += execution.quote;
        self.entry_price = Some(self.notional / self.amount);
        self.verify_increase_protection = true;
        let order = &mut self.orders[index];
        order.average = Some(execution.average());
        order.execution = Some(execution);
        order.status = "filled".into();
        order.error = None;
    }
}

impl Trader {
    pub(super) async fn increase_round_trade(
        &self,
        account: &Account,
        exchange: &Mutex<BinanceusdmCore>,
        intent: &OrderIntent,
        round: &RoundOrder<'_>,
        increase: &RoundIncrease<'_>,
        guard: &impl Fn(bool) -> TradeResult<()>,
    ) -> TradeResult<Value> {
        let _trade_operation = self.begin_trade_operation(increase.trade_id)?;
        let mut trade = self.load(increase.trade_id)?;
        if trade.mode != account.settings.mode
            || !account.matches_key(trade.account_fingerprint.as_deref())
            || trade.round_id.as_deref() != Some(round.round_id)
            || trade.strategy.id != intent.strategy_id
            || trade.symbol != intent.symbol
            || trade.side != intent.side
        {
            return Err("补仓必须对应同一账户、同一轮异动的同向策略持仓。".into());
        }

        let client_id = increase_client_id(round);
        if trade
            .orders
            .iter()
            .any(|order| order.client_order_id.as_deref() == Some(&client_id))
        {
            return Ok(trade.public_value());
        }
        if !trade.hedged || trade.status != "open" || now_ms() >= trade.deadline {
            return Err("该轮没有可补仓的策略持仓。".into());
        }
        if !trade
            .orders
            .iter()
            .any(|order| order.kind == "entry" && order.execution.is_some())
        {
            return Err("首次开仓成交尚未核对，暂不能补仓。".into());
        }
        if trade.leverage != intent.leverage
            || trade.pending_increase().is_some()
            || trade.verify_increase_protection
        {
            return Err("补仓需沿用现有杠杆，并等上一笔补仓核对完成。".into());
        }

        let mut core = exchange.lock().await;
        call_typed(core.load_markets(&[ExchangeValue::Bool(false)]))
            .await
            .map_err(|error| format!("加载交易所市场失败：{}", readable(&error)))?;
        let market = ccxt_pro::get_value(
            &core.markets,
            &ExchangeValue::from(trade.unified_symbol.as_str()),
        )
        .to_json();
        if market.is_null() {
            return Err("找不到这笔交易的币安合约。".into());
        }
        let mark = mark_price(&mut core, &trade.symbol).await?;
        let amount = match intent.size {
            OrderSize::Notional(notional) => {
                order_amount(&core, &trade.unified_symbol, &market, notional, mark)?
            }
            OrderSize::ExchangeMinimum => {
                minimum_order_amount(&market, mark, account.settings.max_notional)?
            }
        };
        self.refresh_pending_exits(&mut core, &mut trade).await;
        check_increase_orders(&mut core, &trade).await?;
        let positions = position_rows(&mut core, &trade.symbol).await?;
        let position = position_value(
            &positions,
            &trade.symbol,
            trade.side.position_side(),
            "positionAmt",
        );
        if !owns_position(&trade, position) {
            return Err("币安同向持仓与该轮策略的剩余数量不一致。".into());
        }
        let estimated_notional = (position.abs() + amount) * mark;
        if !increase.max_position_notional.is_finite()
            || estimated_notional > increase.max_position_notional
            || amount * mark > account.settings.max_notional
        {
            return Err("补仓金额超过单笔或累计持仓上限。".into());
        }
        if now_ms() >= trade.deadline {
            return Err("持仓已到期，跳过补仓。".into());
        }

        guard(true)?;
        let mut pending = order_record(
            ADD_ENTRY,
            trade.side.entry(),
            amount,
            None,
            &Value::Null,
            "placed",
        );
        pending.client_order_id = Some(client_id.clone());
        let index = trade.orders.len();
        trade.orders.push(pending);
        self.save(&trade)?;
        let response = place_market(&mut core, &trade.unified_symbol, trade.side.entry(), amount,
            json!({"newClientOrderId":client_id,"positionSide":trade.side.position_side(),"newOrderRespType":"RESULT"}),
        ).await;
        match response {
            Ok(response) => {
                let order = order_record(
                    ADD_ENTRY,
                    trade.side.entry(),
                    amount,
                    None,
                    &response,
                    "placed",
                );
                trade.orders[index].exchange_id = order.exchange_id;
                if let Some(execution) = order.execution {
                    trade.record_increase(index, execution);
                } else {
                    trade.orders[index].error = Some("补仓成交待币安核对。".into());
                }
            }
            Err(error) if execution_uncertain(&error) => {
                trade.orders[index].error =
                    Some(format!("补仓结果待币安核对：{}", readable(&error)));
            }
            Err(error) => {
                let message = readable(&error);
                trade.orders[index].status = "failed".into();
                trade.orders[index].error = Some(message.clone());
                self.save(&trade)?;
                return Err(message);
            }
        }
        self.save(&trade)?;
        self.verify_round_increase(&mut core, &mut trade).await?;
        self.invalidate_balance().await;
        Ok(trade.public_value())
    }

    pub(super) async fn reconcile_round_increase(
        &self,
        core: &mut BinanceusdmCore,
        trade: &mut Trade,
    ) -> TradeResult<()> {
        let Some(index) = trade.pending_increase() else {
            return self.verify_round_increase(core, trade).await;
        };
        let order = &trade.orders[index];
        let client_id = order
            .client_order_id
            .as_deref()
            .ok_or("待核对的补仓缺少订单标识。")?;
        let args = [ExchangeValue::from_json(
            &json!({"symbol":trade.symbol,"origClientOrderId":client_id}),
        )];
        let result = call_typed(core.fapi_private_get_order(&args)).await;
        match result {
            Ok(response) => {
                let response = response.to_json();
                if response["symbol"] != trade.symbol.as_str()
                    || response["positionSide"] != trade.side.position_side()
                    || !response["side"]
                        .as_str()
                        .is_some_and(|side| side.eq_ignore_ascii_case(&order.side))
                {
                    return Err("币安返回的补仓订单与记录不一致。".into());
                }
                trade.orders[index].exchange_id = order_id(&response["orderId"]);
                if let Some(execution) = binance_execution(&response) {
                    trade.record_increase(index, execution);
                } else if matches!(
                    response["status"].as_str(),
                    Some("CANCELED" | "EXPIRED" | "EXPIRED_IN_MATCH" | "REJECTED")
                ) && super::number(&response["executedQty"]) == Some(0.0)
                {
                    trade.orders[index].status = "canceled".into();
                    trade.orders[index].error = None;
                } else {
                    return Err("补仓成交待币安核对。".into());
                }
            }
            Err(error)
                if error.is("OrderNotFound")
                    && now_ms() - order.time >= ENTRY_RECOVERY_GRACE_MS =>
            {
                trade.orders[index].status = "failed".into();
                trade.orders[index].error = Some("币安没有查到该笔补仓。".into());
            }
            Err(error) => return Err(format!("补仓结果待币安核对：{}", readable(&error))),
        }
        self.save(trade)?;
        self.verify_round_increase(core, trade).await?;
        self.invalidate_balance().await;
        Ok(())
    }

    async fn verify_round_increase(
        &self,
        core: &mut BinanceusdmCore,
        trade: &mut Trade,
    ) -> TradeResult<()> {
        if !trade.verify_increase_protection {
            return Ok(());
        }
        if let Err(error) = check_increase_orders(core, trade).await {
            trade.status = "closing".into();
            trade.error = Some(format!("补仓后保护单无法确认：{error}"));
            trade.exit_reason = Some("补仓后保护单无法确认，市价平仓".into());
        }
        trade.verify_increase_protection = false;
        self.save(trade)
    }
}

fn increase_client_id(round: &RoundOrder<'_>) -> String {
    let mut hash = Sha256::new();
    for value in [round.round_id, round.signal_id] {
        hash.update((value.len() as u64).to_be_bytes());
        hash.update(value.as_bytes());
    }
    let digest = format!("{:x}", hash.finalize());
    format!("pg-{}", &digest[..32])
}

fn owns_position(trade: &Trade, position: f64) -> bool {
    let exited: f64 = trade
        .orders
        .iter()
        .filter(|order| !matches!(order.kind.as_str(), "entry" | ADD_ENTRY))
        .filter_map(|order| order.execution.as_ref())
        .map(|execution| execution.filled)
        .sum();
    let expected = trade.amount - exited;
    position * trade.side.sign() > 0.0 && (expected - position.abs()).abs() <= trade.amount * 1e-8
}

async fn check_increase_orders(core: &mut BinanceusdmCore, trade: &Trade) -> TradeResult<()> {
    let query = [ExchangeValue::from_json(&json!({"symbol":trade.symbol}))];
    let regular = typed(core.fapi_private_get_open_orders(&query))
        .await?
        .to_json();
    let conditional = typed(core.fapi_private_get_open_algo_orders(&query))
        .await?
        .to_json();
    let side = trade.side.position_side();
    let regular = regular.as_array().ok_or("无法读取未成交订单。")?;
    let conditional = conditional.as_array().ok_or("无法读取未成交条件单。")?;
    let belongs_to_trade = |kind, id: Option<String>| {
        id.is_some_and(|id| {
            trade.orders.iter().any(|order| {
                order.kind == kind
                    && order.status == "placed"
                    && order.exchange_id.as_deref() == Some(id.as_str())
            })
        })
    };
    let same_side = |order: &&Value| order["positionSide"] == side;
    if regular
        .iter()
        .filter(same_side)
        .any(|order| !belongs_to_trade(LIMIT_EXIT, order_id(&order["orderId"])))
    {
        return Err("存在其他同方向未成交订单，跳过补仓。".into());
    }
    let mut protected = [false, false];
    for order in conditional.iter().filter(same_side) {
        let id = order_id(&order["algoId"]);
        if order["closePosition"] != true && order["closePosition"] != "true" {
            return Err("同方向条件单需要覆盖整个仓位才能补仓。".into());
        }
        if belongs_to_trade("stop-loss", id.clone()) {
            protected[0] = true;
        } else if belongs_to_trade("take-profit", id) {
            protected[1] = true;
        } else {
            return Err("存在其他同方向条件单，跳过补仓。".into());
        }
    }
    if !protected.into_iter().all(|configured| configured) {
        return Err("止损和止盈条件单需有效，才能补仓。".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binance::Binance;
    use crate::store::Store;
    use crate::trading::{Settings, Side};
    use std::sync::Arc;

    fn demo_trade() -> Trade {
        serde_json::from_value(json!({
            "id":"test", "strategy":{"id":"market-spike","name":"Market Spike"}, "roundId":"BTCUSDT:1:1000",
            "mode":"demo", "symbol":"BTCUSDT", "unifiedSymbol":"BTC/USDT:USDT", "side":"long", "hedged":true,
            "amount":2.0, "notional":200.0, "leverage":1, "entryPrice":100.0, "stopLoss":99.0, "takeProfit":101.0,
            "stopLossPercent":1.0, "takeProfitPercent":1.0, "deadline":9000, "status":"open", "openedAt":1000,
            "note":"", "orders":[],
        })).unwrap()
    }

    #[test]
    fn distinct_signals_in_one_round_have_distinct_and_repeatable_order_ids() {
        let first = RoundOrder {
            round_id: "BTCUSDT:1:1000",
            signal_id: "lower-wick-1",
            increase: None,
        };
        let second = RoundOrder {
            round_id: first.round_id,
            signal_id: "lower-wick-2",
            increase: None,
        };
        let other_round = RoundOrder {
            round_id: "BTCUSDT:1:2000",
            signal_id: first.signal_id,
            increase: None,
        };
        let id = increase_client_id(&first);
        assert_eq!(id, increase_client_id(&first));
        assert_ne!(id, increase_client_id(&second));
        assert_ne!(id, increase_client_id(&other_round));
        assert_eq!(id.len(), 35);
    }

    #[test]
    fn confirmed_addition_increases_managed_quantity_and_keeps_protection_and_deadline() {
        let mut trade = demo_trade();
        let mut exit = order_record(LIMIT_EXIT, "sell", 2.0, None, &Value::Null, "placed");
        exit.execution = Some(Execution {
            filled: 0.5,
            quote: 50.0,
        });
        trade.orders.push(exit);
        assert!(owns_position(&trade, 1.5));
        assert!(!owns_position(&trade, 2.0));
        trade.orders.push(order_record(
            ADD_ENTRY,
            "buy",
            1.0,
            None,
            &Value::Null,
            "placed",
        ));
        assert_eq!(trade.pending_increase(), Some(1));
        trade.record_increase(
            1,
            Execution {
                filled: 1.0,
                quote: 98.0,
            },
        );
        assert_eq!(trade.pending_increase(), None);
        assert!(trade.verify_increase_protection);
        assert!(owns_position(&trade, 2.5));
        assert_eq!(trade.amount, 3.0);
        assert_eq!(trade.notional, 298.0);
        assert_eq!(trade.entry_price, Some(298.0 / 3.0));
        assert_eq!(
            (trade.stop_loss, trade.take_profit, trade.deadline),
            (Some(99.0), Some(101.0), 9000)
        );
    }

    #[tokio::test]
    async fn submitted_addition_is_idempotent_and_cannot_be_reused_for_another_round() {
        let settings = Settings::from_lookup(|key| match key {
            "PLAYGROUND_TRADING_MODE" => Some("demo".into()),
            "BINANCE_DEMO_API_KEY" | "BINANCE_DEMO_API_SECRET" => Some("fixture".into()),
            _ => None,
        });
        let store = Arc::new(Store::open_memory().unwrap());
        let trader = Trader::new(settings, Arc::clone(&store), Arc::new(Binance::new()));
        let account = trader.account.read().await;
        let revision = account.revision;
        let mut trade = demo_trade();
        trade.account_fingerprint = account.fingerprint.clone();
        drop(account);
        let round = |round_id| RoundOrder {
            round_id,
            signal_id: "wick-01",
            increase: Some(RoundIncrease {
                trade_id: "test",
                max_position_notional: 250.0,
            }),
        };
        let mut pending = order_record(ADD_ENTRY, "buy", 1.0, None, &Value::Null, "placed");
        pending.client_order_id = Some(increase_client_id(&round("BTCUSDT:1:1000")));
        trade.orders.push(pending);
        store.save_trade(&trade.to_value()).unwrap();
        let intent = OrderIntent {
            strategy_id: "market-spike".into(),
            strategy_name: "Market Spike".into(),
            symbol: "BTCUSDT".into(),
            side: Side::Long,
            size: OrderSize::ExchangeMinimum,
            leverage: 1,
            stop_loss_percent: 1.0,
            take_profit_percent: 1.0,
            limit_exit_percent: Some(0.75),
            max_hold_seconds: 300,
            note: "".into(),
        };
        let guard = |claim: bool| {
            assert!(!claim);
            Ok(())
        };
        let result = trader
            .submit_guarded(
                intent.clone(),
                revision,
                Some(round("BTCUSDT:1:1000")),
                guard,
            )
            .await
            .unwrap();
        assert_eq!(result["orders"].as_array().unwrap().len(), 1);
        assert!(trader
            .submit_guarded(intent, revision, Some(round("BTCUSDT:1:2000")), guard)
            .await
            .unwrap_err()
            .contains("同一轮"));
    }
}
