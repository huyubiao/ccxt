use ccxt_pro::exchange::ExchangeRuntime;
use ccxt_pro::exchange_generated::ExchangeBase;
use ccxt_pro::exchanges::binanceusdm::BinanceusdmCore;
use ccxt_pro::{
    runtime::{call_typed, catch_typed},
    ExchangeError, Value as ExchangeValue,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use super::{
    binance_execution, closing_order, confirmed_execution, mark_price, now_ms, number, order_id,
    order_record, position_rows, position_value, readable, Side, Trade, TradeOrder, TradeResult,
    Trader,
};

pub(super) const LIMIT_EXIT: &str = "limit-exit";
const STOP_LOSS: &str = "stop-loss";
const TAKE_PROFIT: &str = "take-profit";
const LOOKUP_GRACE_MS: i64 = 30_000;
const LIMIT_RETRY_MS: i64 = 10_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionRequest {
    trade_id: String,
    account_revision: String,
    #[serde(flatten)]
    action: PositionAction,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum PositionAction {
    LimitClose {
        price: f64,
    },
    CancelLimitClose,
    SetProtection {
        stop_loss_price: Option<f64>,
        take_profit_price: Option<f64>,
    },
}

impl Trader {
    pub async fn manage_position(&self, request: PositionRequest) -> TradeResult<Value> {
        let _operation = self.operations.lock().await;
        let account = self.account.read().await;
        if Uuid::parse_str(&request.account_revision).ok() != Some(account.revision) {
            return Err("币安账号状态已变化，请刷新后重试。".into());
        }
        let exchange = account.exchange.as_ref().ok_or("交易未开启。")?;
        let _trade_operation = self.begin_trade_operation(&request.trade_id)?;
        let mut trade = self.load(&request.trade_id)?;
        if trade.mode != account.settings.mode
            || !account.matches_key(trade.account_fingerprint.as_deref())
        {
            return Err("请用这笔交易原来的账户管理持仓。".into());
        }
        if trade.status != "open" {
            return Err("这笔交易当前没有可管理的持仓。".into());
        }
        request.action.validate()?;
        let mut core = exchange.lock().await;
        self.reconcile_round_increase(&mut core, &mut trade).await?;
        if trade.status != "open" {
            return Err("这笔交易已进入平仓处理。".into());
        }
        if let PositionAction::CancelLimitClose = request.action {
            self.cancel_exits(&mut core, &mut trade, Some(LIMIT_EXIT))
                .await?;
        } else {
            self.refresh_pending_exits(&mut core, &mut trade).await;
            let rows = position_rows(&mut core, &trade.symbol).await?;
            let position_side = position_side(&trade);
            let remaining = position_value(&rows, &trade.symbol, position_side, "positionAmt");
            if remaining * trade.side.sign() <= 0.0 {
                return Err("币安当前没有这笔交易方向的持仓。".into());
            }
            if now_ms() >= trade.deadline {
                return Err("持仓已到期，正在等待后台平仓。".into());
            }
            let recorded_exits: f64 = trade
                .orders
                .iter()
                .filter(|order| !matches!(order.kind.as_str(), "entry" | "add-entry"))
                .filter_map(|order| order.execution.as_ref())
                .map(|execution| execution.filled)
                .sum();
            let managed = (trade.amount - recorded_exits).max(0.0);
            if remaining.abs() > managed + trade.amount * 1e-8 {
                return Err("币安同向持仓超过这笔策略交易的剩余数量，请核对持仓后再操作。".into());
            }
            call_typed(core.load_markets(&[ExchangeValue::Bool(false)]))
                .await
                .map_err(|error| format!("加载交易所市场失败：{}", readable(&error)))?;
            let mark = position_value(&rows, &trade.symbol, position_side, "markPrice");
            let mark = if mark > 0.0 {
                mark
            } else {
                mark_price(&mut core, &trade.symbol).await?
            };
            let liquidation =
                position_value(&rows, &trade.symbol, position_side, "liquidationPrice");
            match request.action {
                PositionAction::LimitClose { price } => {
                    let normalized = normalized_price(&core, &trade.unified_symbol, price)?;
                    if normalized != price {
                        return Err(format!(
                            "限价不符合币安价格步长，可使用 {normalized} USDT。"
                        ));
                    }
                    if trade
                        .orders
                        .iter()
                        .any(|order| working(order, Some(LIMIT_EXIT)))
                    {
                        return Err("已有未完成的限价平仓单，请先撤销。".into());
                    }
                    // Older positions may still have quantity-based protection. Use close-all
                    // triggers so a partial fill of the limit order leaves the remainder protected.
                    for kind in [STOP_LOSS, TAKE_PROFIT] {
                        if let Some(price) = trade
                            .orders
                            .iter()
                            .rev()
                            .find(|order| {
                                working(order, Some(kind)) && order.client_order_id.is_none()
                            })
                            .and_then(|order| order.trigger_price)
                        {
                            validate_trigger(trade.side, kind, price, mark, liquidation)?;
                            self.replace_protection(
                                &mut core,
                                &mut trade,
                                kind,
                                price,
                                remaining.abs(),
                            )
                            .await?;
                        }
                    }
                    let current = super::trade_position(&mut core, &trade).await?;
                    if current * trade.side.sign() <= 0.0 || current.abs() > remaining.abs() {
                        return Err("持仓数量已变化，请刷新后再挂限价平仓单。".into());
                    }
                    self.place_limit_exit(&mut core, &mut trade, current, price)
                        .await?;
                }
                PositionAction::SetProtection {
                    stop_loss_price,
                    take_profit_price,
                } => {
                    let mut prices = [
                        (STOP_LOSS, stop_loss_price),
                        (TAKE_PROFIT, take_profit_price),
                    ];
                    for (kind, price) in &mut prices {
                        if let Some(price) = price {
                            *price = normalized_price(&core, &trade.unified_symbol, *price)?;
                            validate_trigger(trade.side, kind, *price, mark, liquidation)?;
                        }
                    }
                    for (kind, price) in prices {
                        if let Some(price) = price {
                            self.replace_protection(
                                &mut core,
                                &mut trade,
                                kind,
                                price,
                                remaining.abs(),
                            )
                            .await?;
                        }
                    }
                }
                PositionAction::CancelLimitClose => unreachable!(),
            }
        }
        drop(core);
        self.invalidate_balance().await;
        Ok(trade.public_value())
    }

    pub(super) async fn setup_automatic_exits(
        &self,
        core: &mut BinanceusdmCore,
        trade: &mut Trade,
    ) -> TradeResult<()> {
        let Some(percent) = trade.pending_limit_exit_percent else {
            return Ok(());
        };
        if now_ms() >= trade.deadline {
            self.close_locked(core, trade, "持仓到期，市价平仓").await;
            return Ok(());
        }

        let protection = async {
            let prices = automatic_exit_prices(core, trade, percent)?;
            let amount = trade.amount;
            for (kind, price) in [(STOP_LOSS, prices.stop), (TAKE_PROFIT, prices.take_profit)] {
                if !trade
                    .orders
                    .iter()
                    .any(|order| working(order, Some(kind)) && order.exchange_id.is_some())
                {
                    self.replace_protection(core, trade, kind, price, amount)
                        .await
                        .map_err(|error| {
                            let label = if kind == STOP_LOSS { "止损" } else { "止盈" };
                            format!("开仓已成交，{label}挂单失败（触发价 {price}）：{error}")
                        })?;
                }
            }
            Ok::<_, String>(prices.limit)
        }
        .await;
        let limit = match protection {
            Ok(price) => price,
            Err(error) => {
                self.close_locked(core, trade, "自动保护单设置失败，市价平仓")
                    .await;
                if trade.status == "closed" {
                    trade.status = "failed".into();
                }
                let message = format!("自动保护单设置失败：{error}");
                trade.error = Some(
                    trade
                        .error
                        .as_ref()
                        .map_or_else(|| message.clone(), |close| format!("{message}；{close}")),
                );
                self.save(trade)?;
                return Err(message);
            }
        };

        match self.ensure_automatic_limit(core, trade, limit).await {
            Ok(true) => {
                trade.pending_limit_exit_percent = None;
                trade.error = None;
                self.save(trade)
            }
            Ok(false) => Ok(()),
            Err(error) => {
                trade.error = Some(format!("自动限价平仓挂单待重试：{error}"));
                self.save(trade)
            }
        }
    }

    async fn ensure_automatic_limit(
        &self,
        core: &mut BinanceusdmCore,
        trade: &mut Trade,
        price: f64,
    ) -> TradeResult<bool> {
        match limit_setup(trade, now_ms()) {
            LimitSetup::Confirmed => return Ok(true),
            LimitSetup::Wait => return Ok(false),
            LimitSetup::Submit => {}
        }
        if now_ms() >= trade.deadline {
            return Ok(false);
        }
        let position = super::trade_position(core, trade).await?;
        if position * trade.side.sign() <= 0.0 {
            return Ok(false);
        }
        self.place_limit_exit(core, trade, position, price).await?;
        Ok(limit_setup(trade, now_ms()) == LimitSetup::Confirmed)
    }

    async fn place_limit_exit(
        &self,
        core: &mut BinanceusdmCore,
        trade: &mut Trade,
        position: f64,
        price: f64,
    ) -> TradeResult<()> {
        let (side, amount, mut params) = closing_order(trade, position);
        params["timeInForce"] = json!("GTC");
        self.submit_exit(core, trade, LIMIT_EXIT, side, amount, price, params)
            .await
    }

    pub(super) async fn replace_protection(
        &self,
        core: &mut BinanceusdmCore,
        trade: &mut Trade,
        kind: &str,
        price: f64,
        amount: f64,
    ) -> TradeResult<()> {
        let price = normalized_price(core, &trade.unified_symbol, price)?;
        let mut previous: Vec<_> = trade
            .orders
            .iter()
            .enumerate()
            .filter(|(_, order)| working(order, Some(kind)))
            .map(|(index, _)| index)
            .collect();
        for &index in &previous {
            if trade.orders[index].exchange_id.is_none() {
                self.sync_exit(core, trade, index, false).await?;
            }
        }
        let matching = previous.iter().rev().copied().find(|&index| {
            let order = &trade.orders[index];
            working(order, Some(kind))
                && order.client_order_id.is_some()
                && order.trigger_price == Some(price)
        });
        if let Some(index) = matching {
            previous.retain(|&candidate| candidate != index);
        } else {
            let side = trade.side.exit();
            let params = protection_params(trade, kind, price);
            self.submit_exit(core, trade, kind, side, amount, price, params)
                .await?;
        }
        if kind == STOP_LOSS {
            trade.stop_loss = Some(price);
        } else {
            trade.take_profit = Some(price);
        }
        self.save(trade)?;
        for index in previous {
            if working(&trade.orders[index], Some(kind)) {
                self.sync_exit(core, trade, index, true)
                    .await
                    .map_err(|error| format!("新保护单已挂出，旧保护单仍待核对：{error}"))?;
            }
        }
        Ok(())
    }

    async fn submit_exit(
        &self,
        core: &mut BinanceusdmCore,
        trade: &mut Trade,
        kind: &str,
        side: &str,
        amount: f64,
        price: f64,
        mut params: Value,
    ) -> TradeResult<()> {
        let limit = kind == LIMIT_EXIT;
        let client_id = format!("pg-{}", Uuid::new_v4().simple());
        params[if limit {
            "newClientOrderId"
        } else {
            "clientAlgoId"
        }] = json!(client_id);
        let mut order = order_record(
            kind,
            side,
            amount,
            (!limit).then_some(price),
            &Value::Null,
            "placed",
        );
        order.limit_price = limit.then_some(price);
        order.client_order_id = Some(client_id);
        let index = trade.orders.len();
        trade.orders.push(order);
        self.save(trade)?;
        let result = call_typed(core.create_order(
            ExchangeValue::from(trade.unified_symbol.as_str()),
            ExchangeValue::from(if limit { "limit" } else { "market" }),
            ExchangeValue::from(side),
            ExchangeValue::Float(amount),
            &[
                if limit {
                    ExchangeValue::Float(price)
                } else {
                    ExchangeValue::Null
                },
                ExchangeValue::from_json(&params),
            ],
        ))
        .await;
        match result {
            Ok(response) => {
                let response = response.to_json();
                let info = &response["info"];
                let order = &mut trade.orders[index];
                order.exchange_id = order_id(&response["id"])
                    .or_else(|| order_id(&info[if limit { "orderId" } else { "algoId" }]));
                if limit {
                    apply_regular(order, info);
                } else if matches!(
                    info["algoStatus"].as_str(),
                    Some("CANCELED" | "EXPIRED" | "REJECTED")
                ) {
                    order.status = "canceled".into();
                }
                self.save(trade)?;
                if trade.orders[index].exchange_id.is_none() {
                    self.sync_exit(core, trade, index, false).await?;
                }
                if matches!(trade.orders[index].status.as_str(), "canceled" | "failed") {
                    return Err("币安未保留该平仓挂单，请查看订单状态。".into());
                }
                Ok(())
            }
            Err(error) => {
                let message = readable(&error);
                let uncertain = execution_uncertain(&error);
                let order = &mut trade.orders[index];
                order.error = Some(message.clone());
                if !uncertain {
                    order.status = "failed".into();
                }
                self.save(trade)?;
                Err(if uncertain {
                    format!("下单结果待币安核对：{message}")
                } else {
                    message
                })
            }
        }
    }

    pub(super) async fn refresh_pending_exits(
        &self,
        core: &mut BinanceusdmCore,
        trade: &mut Trade,
    ) {
        for index in 0..trade.orders.len() {
            let order = &trade.orders[index];
            if working(order, None) {
                let _ = self.sync_exit(core, trade, index, false).await;
            }
        }
    }

    pub(super) async fn cancel_exits(
        &self,
        core: &mut BinanceusdmCore,
        trade: &mut Trade,
        filter: Option<&str>,
    ) -> TradeResult<()> {
        let mut failure = None;
        for index in 0..trade.orders.len() {
            if working(&trade.orders[index], filter) {
                if let Err(error) = self.sync_exit(core, trade, index, true).await {
                    failure = Some(error);
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }

    async fn sync_exit(
        &self,
        core: &mut BinanceusdmCore,
        trade: &mut Trade,
        index: usize,
        cancel: bool,
    ) -> TradeResult<()> {
        let order = &trade.orders[index];
        let previous = order.clone();
        let limit = order.kind == LIMIT_EXIT;
        let query = exit_query(order, &trade.symbol).ok_or("缺少币安订单标识。")?;
        let args = [ExchangeValue::from_json(&query)];
        if cancel {
            if let Ok(response) = exit_request(core, &args, limit, true).await {
                if limit && matches_position(trade, order, &response) {
                    apply_regular(&mut trade.orders[index], &response);
                } else if !limit && number(&response["code"]) == Some(200.0) {
                    trade.orders[index].status = "canceled".into();
                    trade.orders[index].error = None;
                }
                self.save(trade)?;
                if !working(&trade.orders[index], None) {
                    return Ok(());
                }
            }
        }
        let response = match exit_request(core, &args, limit, false).await {
            Ok(response) => response,
            Err(error)
                if error.is("OrderNotFound")
                    && now_ms() - trade.orders[index].time >= LOOKUP_GRACE_MS =>
            {
                trade.orders[index].status = "canceled".into();
                trade.orders[index].error = Some("币安已无此订单可查询。".into());
                return self.save(trade);
            }
            Err(error) => return Err(readable(&error)),
        };
        if !matches_position(trade, &trade.orders[index], &response) {
            return Err("币安返回的订单与当前持仓方向不匹配。".into());
        }
        let order = &mut trade.orders[index];
        if limit {
            apply_regular(order, &response);
        } else {
            order.exchange_id = order_id(&response["algoId"]).or_else(|| order.exchange_id.clone());
            order.error = None;
            if let Some(id) = order_id(&response["actualOrderId"]) {
                let args = [ExchangeValue::from_json(
                    &json!({"symbol":trade.symbol,"orderId":id}),
                )];
                let child = exit_request(core, &args, true, false)
                    .await
                    .map_err(|error| readable(&error))?;
                if !matches_position(trade, &trade.orders[index], &child) {
                    return Err("币安返回的保护单成交方向不匹配。".into());
                }
                let order = &mut trade.orders[index];
                apply_execution(order, &child);
                if let Some(status) = regular_status(&child) {
                    if status != "placed" {
                        order.status = if order.execution.is_some() {
                            "triggered"
                        } else {
                            status
                        }
                        .into();
                    }
                }
            } else if matches!(
                response["algoStatus"].as_str(),
                Some("CANCELED" | "EXPIRED" | "REJECTED" | "FINISHED")
            ) {
                order.status = "canceled".into();
            }
        }
        if trade.orders[index] != previous {
            self.save(trade)?;
        }
        if cancel && working(&trade.orders[index], None) {
            return Err("交易所仍有未结束的平仓订单。".into());
        }
        Ok(())
    }
}

pub(super) fn execution_uncertain(error: &ExchangeError) -> bool {
    error.is("NetworkError")
        || error.is("OperationFailed")
        || error.message.contains("-1006")
        || error.message.contains("-1007")
}

#[derive(Debug, PartialEq)]
enum LimitSetup {
    Confirmed,
    Wait,
    Submit,
}

fn limit_setup(trade: &Trade, now: i64) -> LimitSetup {
    match trade
        .orders
        .iter()
        .rev()
        .find(|order| order.kind == LIMIT_EXIT)
    {
        Some(order)
            if order.status == "filled"
                || (order.status == "placed" && order.exchange_id.is_some()) =>
        {
            LimitSetup::Confirmed
        }
        Some(order) if order.status == "placed" || now - order.time < LIMIT_RETRY_MS => {
            LimitSetup::Wait
        }
        _ => LimitSetup::Submit,
    }
}

#[derive(Debug, PartialEq)]
struct ExitPrices {
    stop: f64,
    limit: f64,
    take_profit: f64,
}

fn automatic_exit_prices(
    core: &BinanceusdmCore,
    trade: &Trade,
    limit_percent: f64,
) -> TradeResult<ExitPrices> {
    let symbol = trade.unified_symbol.as_str();
    let market = ccxt_pro::get_value(&core.markets, &ExchangeValue::from(symbol)).to_json();
    let tick = number(&market["precision"]["price"])
        .filter(|tick| *tick > 0.0)
        .ok_or("无法读取自动平仓的价格步长。")?;
    let entry = trade
        .entry_price
        .filter(|entry| entry.is_finite() && *entry > 0.0)
        .ok_or("开仓均价尚未确认。")?;
    let direction = trade.side.sign();
    let round = |price| normalized_price(core, symbol, price);
    let stop_target = entry * (1.0 - direction * trade.stop_loss_percent / 100.0);
    let mut stop = round(stop_target)?;
    if (stop - stop_target) * direction < -entry * f64::EPSILON * 4.0 {
        stop = round(stop + direction * tick)?;
    }
    let mut limit = round(entry * (1.0 + direction * limit_percent / 100.0))?;
    if (limit - entry) * direction <= 0.0 {
        limit = round(limit + direction * tick)?;
    }
    let mut take_profit = round(entry * (1.0 + direction * trade.take_profit_percent / 100.0))?;
    if (take_profit - limit) * direction <= 0.0 {
        take_profit = round(limit + direction * tick)?;
    }
    if (stop - entry) * direction >= 0.0
        || (limit - entry) * direction <= 0.0
        || (take_profit - limit) * direction <= 0.0
    {
        return Err("按币安价格步长无法区分止损、开仓、限价平仓和止盈价格。".into());
    }
    Ok(ExitPrices {
        stop,
        limit,
        take_profit,
    })
}

impl PositionAction {
    fn validate(&self) -> TradeResult<()> {
        let valid = |price: f64| price.is_finite() && price > 0.0;
        match self {
            Self::LimitClose { price } if !valid(*price) => Err("平仓限价必须大于 0。".into()),
            Self::SetProtection {
                stop_loss_price: None,
                take_profit_price: None,
            } => Err("至少填写一个止损或止盈触发价。".into()),
            Self::SetProtection {
                stop_loss_price,
                take_profit_price,
            } if !stop_loss_price.is_none_or(valid) || !take_profit_price.is_none_or(valid) => {
                Err("止损和止盈触发价必须大于 0。".into())
            }
            _ => Ok(()),
        }
    }
}

fn position_side(trade: &Trade) -> &'static str {
    if trade.hedged {
        trade.side.position_side()
    } else {
        "BOTH"
    }
}

fn working(order: &TradeOrder, kind: Option<&str>) -> bool {
    order.status == "placed"
        && matches!(order.kind.as_str(), LIMIT_EXIT | STOP_LOSS | TAKE_PROFIT)
        && kind.is_none_or(|kind| order.kind == kind)
}

fn protection_params(trade: &Trade, kind: &str, price: f64) -> Value {
    let key = if kind == STOP_LOSS {
        "stopLossPrice"
    } else {
        "takeProfitPrice"
    };
    json!({key: price, "positionSide": position_side(trade), "workingType": "MARK_PRICE", "closePosition": true})
}

fn normalized_price(core: &BinanceusdmCore, symbol: &str, price: f64) -> TradeResult<f64> {
    if !price.is_finite() || price <= 0.0 {
        return Err("价格必须大于 0。".into());
    }
    catch_typed(|| {
        ExchangeBase::price_to_precision(
            core,
            ExchangeValue::from(symbol),
            ExchangeValue::Float(price),
        )
    })
    .ok()
    .and_then(|value| number(&value.to_json()))
    .filter(|price| *price > 0.0)
    .ok_or_else(|| "价格低于交易所精度或无法换算。".into())
}

fn validate_trigger(
    side: Side,
    kind: &str,
    price: f64,
    mark: f64,
    liquidation: f64,
) -> TradeResult<()> {
    let above =
        (side == Side::Short && kind == STOP_LOSS) || (side == Side::Long && kind == TAKE_PROFIT);
    if (above && price <= mark) || (!above && price >= mark) {
        let kind = if kind == STOP_LOSS {
            "止损"
        } else {
            "止盈"
        };
        let direction = if above { "高于" } else { "低于" };
        return Err(format!("{kind}触发价须{direction}当前标记价 {mark}。"));
    }
    if kind == STOP_LOSS && liquidation > 0.0 && (price - liquidation) * side.sign() <= 0.0 {
        return Err(format!("止损触发价须在预估强平价 {liquidation} 之前触发。"));
    }
    Ok(())
}

fn exit_query(order: &TradeOrder, symbol: &str) -> Option<Value> {
    let limit = order.kind == LIMIT_EXIT;
    let mut query = if limit {
        json!({"symbol":symbol})
    } else {
        json!({})
    };
    if let Some(id) = &order.exchange_id {
        query[if limit { "orderId" } else { "algoId" }] = json!(id);
    } else {
        query[if limit {
            "origClientOrderId"
        } else {
            "clientAlgoId"
        }] = json!(order.client_order_id.as_ref()?);
    }
    Some(query)
}

async fn exit_request(
    core: &mut BinanceusdmCore,
    args: &[ExchangeValue],
    limit: bool,
    cancel: bool,
) -> Result<Value, ExchangeError> {
    call_typed(async {
        match (limit, cancel) {
            (true, true) => core.fapi_private_delete_order(args).await,
            (true, false) => core.fapi_private_get_order(args).await,
            (false, true) => core.fapi_private_delete_algo_order(args).await,
            (false, false) => core.fapi_private_get_algo_order(args).await,
        }
    })
    .await
    .map(|value| value.to_json())
}

fn matches_position(trade: &Trade, order: &TradeOrder, response: &Value) -> bool {
    response["symbol"] == trade.symbol.as_str()
        && response["positionSide"] == position_side(trade)
        && response["side"]
            .as_str()
            .is_some_and(|side| side.eq_ignore_ascii_case(&order.side))
}

fn regular_status(order: &Value) -> Option<&'static str> {
    match order["status"].as_str()? {
        "NEW" | "PARTIALLY_FILLED" => Some("placed"),
        "FILLED" => Some("filled"),
        "CANCELED" | "EXPIRED" | "EXPIRED_IN_MATCH" => Some("canceled"),
        "REJECTED" => Some("failed"),
        _ => None,
    }
}

fn apply_regular(order: &mut TradeOrder, response: &Value) {
    order.exchange_id = order_id(&response["orderId"]).or_else(|| order.exchange_id.clone());
    if let Some(status) = regular_status(response) {
        order.status = status.into();
        order.error = None;
    }
    apply_execution(order, response);
}

fn apply_execution(order: &mut TradeOrder, response: &Value) {
    let execution = if response["status"] == "PARTIALLY_FILLED" {
        confirmed_execution(
            &response["executedQty"],
            &response["cumQuote"],
            &response["avgPrice"],
        )
    } else {
        binance_execution(response)
    };
    if let Some(execution) = execution {
        if order
            .execution
            .as_ref()
            .is_none_or(|saved| execution.filled >= saved.filled)
        {
            order.average = Some(execution.average());
            order.execution = Some(execution);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trade(side: Side, hedged: bool) -> Trade {
        serde_json::from_value(json!({
            "id":"trade", "strategy":{"id":"market-spike","name":"异动监控策略"}, "mode":"demo",
            "symbol":"BTCUSDT", "unifiedSymbol":"BTC/USDT:USDT", "side":side, "hedged":hedged,
            "amount":2, "notional":200, "entryPrice":100, "leverage":1, "stopLossPercent":1, "takeProfitPercent":1,
            "deadline":1000, "status":"open", "openedAt":1, "note":"", "orders":[]
        }))
        .unwrap()
    }

    #[test]
    fn limit_and_protection_use_the_reducing_side() {
        for (direction, qty, side, position) in [
            (Side::Long, 1.5, "sell", "LONG"),
            (Side::Short, -1.5, "buy", "SHORT"),
        ] {
            let trade = trade(direction, true);
            let (order_side, amount, limit) = closing_order(&trade, qty);
            assert_eq!((order_side, amount), (side, 1.5));
            assert_eq!(limit, json!({"positionSide":position}));
            assert_eq!(
                protection_params(&trade, STOP_LOSS, 100.0),
                json!({
                    "stopLossPrice":100.0, "positionSide":position, "workingType":"MARK_PRICE", "closePosition":true,
                })
            );
        }
        let legacy = trade(Side::Short, false);
        assert_eq!(closing_order(&legacy, -1.5).2, json!({"reduceOnly":true}));
        assert_eq!(
            protection_params(&legacy, TAKE_PROFIT, 100.0)["positionSide"],
            "BOTH"
        );
    }

    fn market_client(tick: f64) -> BinanceusdmCore {
        let mut core = BinanceusdmCore::new(None);
        ExchangeBase::set_markets(
            &mut core,
            ExchangeValue::from_json(&json!([{
                "id":"BTCUSDT", "symbol":"BTC/USDT:USDT", "base":"BTC", "quote":"USDT", "settle":"USDT",
                "type":"swap", "swap":true, "linear":true, "contract":true,
                "precision":{"price":tick, "amount":0.001},
                "info":{"orderTypes":["LIMIT", "MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET"]}
            }])),
            &[],
        );
        core
    }

    #[test]
    fn auto_exit_levels_use_the_fill_and_keep_profit_targets_distinct_in_both_directions() {
        let core = market_client(0.01);
        assert_eq!(
            automatic_exit_prices(&core, &trade(Side::Long, true), 0.75).unwrap(),
            ExitPrices {
                stop: 99.0,
                limit: 100.75,
                take_profit: 101.0
            }
        );
        assert_eq!(
            automatic_exit_prices(&core, &trade(Side::Short, true), 0.75).unwrap(),
            ExitPrices {
                stop: 101.0,
                limit: 99.25,
                take_profit: 99.0
            }
        );
        let mut coarse = trade(Side::Short, true);
        coarse.take_profit_percent = 0.5;
        assert_eq!(
            automatic_exit_prices(&market_client(1.0), &coarse, 0.375).unwrap(),
            ExitPrices {
                stop: 101.0,
                limit: 99.0,
                take_profit: 98.0
            }
        );
        coarse.stop_loss_percent = 0.5;
        assert!(automatic_exit_prices(&market_client(1.0), &coarse, 0.375).is_err());
        coarse.entry_price = None;
        assert!(automatic_exit_prices(&core, &coarse, 0.375).is_err());
    }

    #[test]
    fn automatic_limit_waits_for_uncertain_submission_and_retries_rejected_orders() {
        let mut trade = trade(Side::Long, true);
        let now = now_ms();
        assert_eq!(limit_setup(&trade, now), LimitSetup::Submit);
        let mut order = order_record(LIMIT_EXIT, "sell", 2.0, None, &Value::Null, "placed");
        order.client_order_id = Some("pending-client-id".into());
        trade.orders.push(order);
        trade.pending_limit_exit_percent = Some(0.75);
        let mut trade: Trade = serde_json::from_value(trade.to_value()).unwrap();
        assert_eq!(trade.pending_limit_exit_percent, Some(0.75));
        assert_eq!(limit_setup(&trade, now + 50_000), LimitSetup::Wait);
        trade.orders[0].status = "failed".into();
        assert_eq!(limit_setup(&trade, now + 1_000), LimitSetup::Wait);
        assert_eq!(
            limit_setup(&trade, now + LIMIT_RETRY_MS + 1_000),
            LimitSetup::Submit
        );
        trade.orders[0].status = "placed".into();
        trade.orders[0].exchange_id = Some("123".into());
        assert_eq!(limit_setup(&trade, now), LimitSetup::Confirmed);
    }

    #[test]
    fn binance_wire_orders_preserve_close_side_and_do_not_send_quantity_for_protection() {
        let core = market_client(0.01);
        let symbol = "BTC/USDT:USDT";
        let trade = trade(Side::Short, true);
        let (side, amount, mut limit_params) = closing_order(&trade, -0.125);
        limit_params["timeInForce"] = json!("GTC");
        let limit = core
            .parent
            .create_order_request(
                ExchangeValue::from(symbol),
                ExchangeValue::from("limit"),
                ExchangeValue::from(side),
                ExchangeValue::Float(amount),
                &[
                    ExchangeValue::Float(95.0),
                    ExchangeValue::from_json(&limit_params),
                ],
            )
            .to_json();
        assert_eq!(limit["side"], "BUY");
        assert_eq!(limit["positionSide"], "SHORT");
        assert_eq!(limit["type"], "LIMIT");
        assert_eq!(limit["timeInForce"], "GTC");
        assert_eq!(number(&limit["quantity"]), Some(amount));
        assert!(limit.get("reduceOnly").is_none());

        let mut params = protection_params(&trade, STOP_LOSS, 105.0);
        params["isAlgoOrder"] = json!(true);
        let stop = core
            .parent
            .create_order_request(
                ExchangeValue::from(symbol),
                ExchangeValue::from("market"),
                ExchangeValue::from(side),
                ExchangeValue::Float(amount),
                &[ExchangeValue::Null, ExchangeValue::from_json(&params)],
            )
            .to_json();
        assert_eq!(stop["type"], "STOP_MARKET");
        assert_eq!(stop["positionSide"], "SHORT");
        assert_eq!(stop["side"], "BUY");
        assert_eq!(stop["workingType"], "MARK_PRICE");
        assert_eq!(number(&stop["triggerPrice"]), Some(105.0));
        assert_eq!(stop["closePosition"], true);
        assert!(stop.get("quantity").is_none());
        assert!(stop.get("reduceOnly").is_none());
    }

    #[test]
    fn validates_mark_and_liquidation_boundaries_in_both_directions() {
        for (side, stop, take, liquidation) in [
            (Side::Long, 95.0, 105.0, 90.0),
            (Side::Short, 105.0, 95.0, 110.0),
        ] {
            assert!(validate_trigger(side, STOP_LOSS, stop, 100.0, liquidation).is_ok());
            assert!(validate_trigger(side, TAKE_PROFIT, take, 100.0, liquidation).is_ok());
            assert!(validate_trigger(side, STOP_LOSS, take, 100.0, liquidation).is_err());
            assert!(validate_trigger(side, STOP_LOSS, liquidation, 100.0, liquidation).is_err());
            assert!(validate_trigger(side, TAKE_PROFIT, 100.0, 100.0, liquidation).is_err());
        }
    }

    #[test]
    fn partial_limit_fills_survive_cancellation_and_older_snapshots() {
        let mut order = order_record(LIMIT_EXIT, "sell", 2.0, None, &Value::Null, "placed");
        order.client_order_id = Some("pg-fixture".into());
        assert_eq!(
            exit_query(&order, "BTCUSDT").unwrap(),
            json!({"symbol":"BTCUSDT", "origClientOrderId":"pg-fixture"})
        );
        apply_regular(
            &mut order,
            &json!({"orderId":1, "status":"PARTIALLY_FILLED", "executedQty":"0.5", "cumQuote":"50"}),
        );
        assert!(working(&order, Some(LIMIT_EXIT)));
        assert_eq!(order.execution.as_ref().unwrap().filled, 0.5);
        apply_regular(
            &mut order,
            &json!({"orderId":1, "status":"CANCELED", "executedQty":"0.75", "cumQuote":"76"}),
        );
        apply_execution(
            &mut order,
            &json!({"status":"PARTIALLY_FILLED", "executedQty":"0.5", "cumQuote":"50"}),
        );
        assert!(!working(&order, None));
        assert_eq!(order.status, "canceled");
        assert_eq!(order.execution.unwrap().quote, 76.0);
    }

    #[test]
    fn protection_request_can_edit_one_trigger() {
        let request: PositionRequest = serde_json::from_value(json!({
            "action":"set-protection", "tradeId":"trade", "accountRevision":Uuid::new_v4().to_string(), "takeProfitPrice":123.0,
        })).unwrap();
        assert!(request.action.validate().is_ok());
        assert!(matches!(
            request.action,
            PositionAction::SetProtection {
                stop_loss_price: None,
                take_profit_price: Some(123.0)
            }
        ));
        assert!(PositionAction::SetProtection {
            stop_loss_price: None,
            take_profit_price: None
        }
        .validate()
        .is_err());
        assert!(PositionAction::LimitClose { price: 0.0 }
            .validate()
            .is_err());
    }
}
