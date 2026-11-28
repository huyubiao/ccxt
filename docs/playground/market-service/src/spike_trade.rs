use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{oneshot, watch, Semaphore};

use crate::binance::{number, Binance, Contract, Endpoint, TradeWindow, VOLUME_DELAY_MS};
use crate::now_ms;
use crate::store::{Result, Store};
use crate::strategy::{Move, Rule, Volume, MARKET_SPIKE_ID, MARKET_SPIKE_NAME};
use crate::trading::{OrderIntent, OrderSize, RoundOrder, Side, Trader};

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const MAX_ALERT_AGE_MS: i64 = 45_000;
const ORDER_SCORE: u8 = 80;
const BREAKOUT_WINDOW_MS: i64 = 5_000;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum BreakoutPosition {
    Held,
    Recovered,
    Retained,
    Half,
    Endangered,
    Lost,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub(crate) enum BreakoutObservation {
    Pending,
    QueueSkipped,
    NoTrades,
    Unavailable,
    Ready {
        window_seconds: i64,
        buy_usdt: f64,
        sell_usdt: f64,
        net_percent: f64,
        position: BreakoutPosition,
        target_price: f64,
        reference_price: f64,
        worst_price: f64,
        last_price: f64,
        last_trade_time: i64,
    },
}

pub(crate) async fn observe_breakout(
    binance: &Binance,
    symbol: &str,
    movement: Move,
    upward: bool,
) -> BreakoutObservation {
    let start = movement.sample.time + 1;
    let end = start + BREAKOUT_WINDOW_MS;
    let trades = tokio::time::timeout(Duration::from_secs(15), async {
        let delay = (end - 1 + VOLUME_DELAY_MS - now_ms()).max(0) as u64;
        tokio::time::sleep(Duration::from_millis(delay)).await;
        binance.trade_window(symbol, start, end).await
    })
    .await;
    match trades {
        Ok(Ok(trades)) => measure_breakout(trades, movement.sample.price, movement.previous, upward),
        _ => BreakoutObservation::Unavailable,
    }
}

fn measure_breakout(trades: TradeWindow, target_price: f64, reference_price: f64, upward: bool) -> BreakoutObservation {
    let Some(last) = trades.last else {
        return BreakoutObservation::NoTrades;
    };
    let on_breakout_side = |price: f64, boundary: f64| {
        (price - boundary).abs() <= f64::EPSILON * price.max(boundary) * 4.0
            || if upward {
                price > boundary
            } else {
                price < boundary
            }
    };
    let worst_price = if upward { trades.low } else { trades.high };
    let retained_price = reference_price + (target_price - reference_price) * 3.0 / 4.0;
    let half_price = reference_price + (target_price - reference_price) / 2.0;
    let position = if on_breakout_side(last.price, target_price) {
        if on_breakout_side(worst_price, target_price) {
            BreakoutPosition::Held
        } else {
            BreakoutPosition::Recovered
        }
    } else if on_breakout_side(last.price, retained_price) {
        BreakoutPosition::Retained
    } else if on_breakout_side(last.price, half_price) {
        BreakoutPosition::Half
    } else if (upward && last.price > reference_price) || (!upward && last.price < reference_price) {
        BreakoutPosition::Endangered
    } else {
        BreakoutPosition::Lost
    };
    let sell_usdt = trades.total - trades.taker_buy;
    BreakoutObservation::Ready {
        window_seconds: BREAKOUT_WINDOW_MS / 1_000,
        buy_usdt: trades.taker_buy,
        sell_usdt,
        net_percent: (trades.taker_buy - sell_usdt) / trades.total * 100.0,
        position,
        target_price,
        reference_price,
        worst_price,
        last_price: last.price,
        last_trade_time: last.time,
    }
}

pub struct Evaluation {
    pub id: String,
    pub round_id: String,
    pub contract: Contract,
    pub trigger_time: i64,
    pub interval_start: i64,
    pub entry_candidate: bool,
    pub side: Side,
    pub volume: Volume,
    pub(crate) observation: Option<oneshot::Receiver<BreakoutObservation>>,
    pub rule: Rule,
    pub owner: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Score {
    breakout_points: u8,
    flow_points: u8,
    price_points: u8,
    turnover_points: u8,
    total: u8,
    range_percent: Option<f64>,
    quietness: Option<Quietness>,
    turnover_bonus: TurnoverBonus,
    flow: FlowScore,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DepthEvidence {
    time: i64,
    bid_usdt: f64,
    ask_usdt: f64,
    bid_levels: usize,
    ask_levels: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FlowScore {
    start: i64,
    end: i64,
    buy_usdt: f64,
    sell_usdt: f64,
    aligned_percent: f64,
    active_points: u8,
    depth: Option<DepthEvidence>,
    depth_percent: Option<f64>,
    depth_points: u8,
    depth_max_points: u8,
    points: u8,
}

impl FlowScore {
    fn new(start: i64, end: i64, buy: f64, total: f64, side: Side, depth: Option<DepthEvidence>) -> Self {
        let aligned = if side == Side::Long { buy } else { total - buy };
        let aligned_percent = (aligned / total * 10_000.0).round() / 100.0;
        let active_points = match aligned_percent {
            share if share >= 75.0 => 35,
            share if share >= 70.0 => 30,
            share if share >= 65.0 => 20,
            share if share >= 60.0 => 15,
            share if share >= 55.0 => 10,
            _ => 0,
        };
        let depth_percent = depth.as_ref().map(|book| {
            let aligned = if side == Side::Long { book.bid_usdt } else { book.ask_usdt };
            (aligned / (book.bid_usdt + book.ask_usdt) * 10_000.0).round() / 100.0
        });
        let depth_points = match depth_percent {
            Some(share) if share >= 80.0 => 25,
            Some(share) if share >= 75.0 => 20,
            Some(share) if share >= 70.0 => 15,
            Some(share) if share >= 65.0 => 10,
            Some(share) if share >= 60.0 => 5,
            _ => 0,
        };
        Self { start, end, buy_usdt: buy, sell_usdt: total - buy, aligned_percent, active_points,
            depth, depth_percent, depth_points, depth_max_points: 25,
            points: (active_points + depth_points).min(35) }
    }
}

fn measure_depth(book: Value, now: i64) -> Option<DepthEvidence> {
    let time = book["E"].as_i64().or_else(|| book["T"].as_i64())?;
    if !(now - 15_000..=now + 2_000).contains(&time) { return None; }
    let levels = |key: &str| -> Option<(f64, usize, f64)> {
        let rows = book[key].as_array()?;
        if rows.is_empty() || rows.len() > 1000 { return None; }
        let mut sum = 0.0;
        for row in rows {
            let price = number(&row[0])?;
            let quantity = number(&row[1])?;
            if price <= 0.0 || quantity < 0.0 { return None; }
            sum += price * quantity;
        }
        let best = number(&rows[0][0])?;
        (sum.is_finite() && sum > 0.0).then_some((sum, rows.len(), best))
    };
    let (bid_usdt, bid_levels, bid) = levels("bids")?;
    let (ask_usdt, ask_levels, ask) = levels("asks")?;
    (bid < ask && (bid_usdt + ask_usdt).is_finite()).then_some(DepthEvidence {
        time, bid_usdt, ask_usdt, bid_levels, ask_levels,
    })
}

async fn interval_flow(binance: &Binance, symbol: &str, start: i64, end: i64) -> Option<(f64, f64)> {
    if start >= end { return None; }
    let first_minute = (start + MINUTE_MS - 1).div_euclid(MINUTE_MS) * MINUTE_MS;
    let last_minute = end.div_euclid(MINUTE_MS) * MINUTE_MS;
    if first_minute > last_minute {
        let trades = binance.trade_window(symbol, start, end).await.ok()?;
        return (trades.total > 0.0).then_some((trades.taker_buy, trades.total));
    }
    let (head, tail) = tokio::join!(
        binance.trade_window(symbol, start, first_minute),
        binance.trade_window(symbol, last_minute, end),
    );
    let (head, tail) = (head.ok()?, tail.ok()?);
    let mut buy = head.taker_buy + tail.taker_buy;
    let mut total = head.total + tail.total;
    let mut cursor = first_minute;
    while cursor < last_minute {
        let until = last_minute.min(cursor + 499 * MINUTE_MS);
        let rows: Vec<Value> = binance.get(Endpoint::Klines, json!({
            "symbol":symbol,"interval":"1m","startTime":cursor,"endTime":until-1,
            "limit":(until-cursor)/MINUTE_MS,
        })).await.ok()?;
        let (minute_buy, minute_total) = minute_flow(&rows, cursor, until)?;
        buy += minute_buy;
        total += minute_total;
        cursor = until;
    }
    (total.is_finite() && buy.is_finite() && total > 0.0 && buy <= total).then_some((buy, total))
}

fn minute_flow(rows: &[Value], start: i64, end: i64) -> Option<(f64, f64)> {
    if rows.len() as i64 != (end - start) / MINUTE_MS { return None; }
    let mut cursor = start;
    let mut buy = 0.0;
    let mut total = 0.0;
    for row in rows {
        let amount = number(&row[7])?;
        let taker_buy = number(&row[10])?;
        if row[0].as_i64()? != cursor || row[6].as_i64()? != cursor + MINUTE_MS - 1
            || amount < 0.0 || taker_buy < 0.0 || taker_buy > amount { return None; }
        buy += taker_buy;
        total += amount;
        cursor += MINUTE_MS;
    }
    (buy.is_finite() && total.is_finite()).then_some((buy, total))
}

impl Score {
    fn calculate(
        quietness: Option<Quietness>,
        turnover_bonus: TurnoverBonus,
        position: BreakoutPosition,
        flow: FlowScore,
    ) -> Self {
        let breakout_points = match position {
            BreakoutPosition::Held => 35,
            BreakoutPosition::Recovered => 30,
            BreakoutPosition::Retained => 20,
            BreakoutPosition::Half => 15,
            BreakoutPosition::Endangered => 5,
            BreakoutPosition::Lost => 0,
        };
        let flow_points = flow.points;
        let price_points = quietness.as_ref().map_or(0, |quiet| quiet.points);
        let range_percent = quietness.as_ref().map(|quiet| quiet.range_percent);
        let turnover_points = turnover_bonus.points;
        Self {
            breakout_points,
            flow_points,
            price_points,
            turnover_points,
            total: breakout_points + flow_points + price_points + turnover_points,
            range_percent,
            quietness,
            turnover_bonus,
            flow,
        }
    }

    fn allows_entry(&self, position: BreakoutPosition) -> bool {
        position != BreakoutPosition::Lost && self.total >= ORDER_SCORE
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Quietness {
    start: i64,
    end: i64,
    range_percent: f64,
    drift_percent: f64,
    max_candle_percent: f64,
    range_points: u8,
    drift_points: u8,
    candle_points: u8,
    points: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnoverBonus {
    first: bool,
    multiple: Option<f64>,
    points: u8,
    current_turnover: Option<f64>,
    previous_turnover: Option<f64>,
}

impl TurnoverBonus {
    fn new(first: bool, multiple: Option<f64>) -> Self {
        let thresholds = if first { [100.0, 200.0, 400.0, 700.0, 1000.0] }
            else { [5.0, 10.0, 20.0, 50.0, 100.0] };
        let points = multiple.filter(|n| n.is_finite() && *n >= 0.0).map_or(0, |multiple| {
            thresholds.into_iter().zip([3, 5, 10, 15, 20])
                .filter(|(threshold, _)| multiple > *threshold)
                .map(|(_, points)| points).last().unwrap_or(0)
        });
        Self { first, multiple: multiple.filter(|n| n.is_finite() && *n >= 0.0), points,
            current_turnover: None, previous_turnover: None }
    }
}

pub struct Evaluator {
    pub store: Arc<Store>,
    pub binance: Arc<Binance>,
    pub trader: Arc<Trader>,
    pub stop: watch::Receiver<bool>,
    pub slots: Semaphore,
    pub quiet_lock: tokio::sync::Mutex<()>,
}

impl Evaluator {
    async fn quietness(&self, job: &Evaluation) -> Result<Option<Quietness>> {
        let _lock = self.quiet_lock.lock().await;
        let Some(first) = self.store.round_alert(&job.round_id, None)? else { return Ok(None); };
        if let Some(saved) = first.get("quietness") {
            return Ok(serde_json::from_value(saved.clone())?);
        }
        let trigger = first["time"].as_i64().ok_or("Missing first trigger time")?;
        let seconds = first["seconds"].as_i64().ok_or("Missing alert window")?;
        let hours = first["quietLookbackHours"].as_u64().unwrap_or(u64::from(job.rule.continuation.lookback_hours));
        let quiet = tokio::time::timeout(Duration::from_secs(12),
            historical_quietness(&self.binance, &job.contract, trigger, seconds, hours)).await.ok().flatten();
        self.store.save_round_quietness(&job.round_id, &json!(quiet))?;
        Ok(quiet)
    }

    async fn turnover_bonus(&self, job: &Evaluation, total: f64) -> Result<TurnoverBonus> {
        if job.entry_candidate {
            let mut bonus = TurnoverBonus::new(true, job.volume.multiple);
            bonus.current_turnover = job.volume.turnover;
            bonus.previous_turnover = job.volume.baseline;
            return Ok(bonus);
        }
        let Some(previous) = self.store.round_alert(&job.round_id, Some(job.trigger_time))? else {
            return Ok(TurnoverBonus::new(false, None));
        };
        let previous_total = if previous.get("observationMinutes").is_none() {
            previous["volume"]["turnover"].as_f64()
        } else if let Some(saved) = previous["intervalTurnover"].as_f64() {
            Some(saved)
        } else if let (Some(start), Some(time)) = (previous["intervalStart"].as_i64(), previous["time"].as_i64()) {
            let flow = tokio::time::timeout(Duration::from_secs(12),
                interval_flow(&self.binance, &job.contract.id, start, time + 1)).await.ok().flatten();
            if let Some((_, amount)) = flow {
                self.store.save_interval_turnover(&job.round_id, time, amount)?;
            }
            flow.map(|(_, amount)| amount)
        } else { None };
        let mut bonus = TurnoverBonus::new(false,
            previous_total.filter(|amount| *amount > 0.0).map(|amount| total / amount));
        bonus.current_turnover = Some(total);
        bonus.previous_turnover = previous_total;
        Ok(bonus)
    }

    pub async fn evaluate(&self, mut job: Evaluation) -> Result<()> {
        let (depth, account_revision) = tokio::join!(
            tokio::time::timeout(Duration::from_secs(8),
                self.binance.get::<Value>(Endpoint::Depth, json!({"symbol":job.contract.id,"limit":1000}))),
            async {
                if job.rule.continuation.auto_trade {
                    self.trader.auto_account_revision().await
                } else {
                    None
                }
            },
        );
        let depth = depth.ok().and_then(|book| book.ok()).and_then(|book| measure_depth(book, now_ms()));
        let _permit = self.slots.acquire().await?;
        let current = || !*self.stop.borrow() && now_ms() - job.trigger_time <= MAX_ALERT_AGE_MS;
        if !current() || self.store.rule()? != job.rule {
            return self
                .store
                .finish_spike_evaluation(&job.id, &json!({"status":"interrupted"}));
        }
        let Some(observation) = job.observation.take() else {
            return self.store.finish_spike_evaluation(&job.id, &json!({"status":"observation-unavailable","side":job.side,"target":ORDER_SCORE}));
        };
        let (quietness, observation, flow) = tokio::join!(
            self.quietness(&job),
            observation,
            tokio::time::timeout(Duration::from_secs(12),
                interval_flow(&self.binance, &job.contract.id, job.interval_start, job.trigger_time + 1)),
        );
        let Ok(BreakoutObservation::Ready { position, .. }) = observation else {
            let status = if current() { "observation-unavailable" } else { "interrupted" };
            return self.store.finish_spike_evaluation(&job.id, &json!({"status":status,"side":job.side,"target":ORDER_SCORE}));
        };
        let Ok(Some((buy, total))) = flow else {
            return self.store.finish_spike_evaluation(&job.id, &json!({
                "status":"flow-unavailable","side":job.side,"target":ORDER_SCORE
            }));
        };
        let depth = depth.filter(|book| now_ms() - book.time <= 15_000);
        let flow = FlowScore::new(job.interval_start, job.trigger_time, buy, total, job.side, depth);
        self.store.save_interval_turnover(&job.round_id, job.trigger_time, total)?;
        let bonus = self.turnover_bonus(&job, total).await?;
        let score = Score::calculate(
            quietness?, bonus, position, flow,
        );
        let mut result = json!({"score":score,"side":job.side,"target":ORDER_SCORE});
        let status = match (
            score.allows_entry(position),
            job.rule.continuation.auto_trade,
            account_revision,
        ) {
            _ if !current() => "interrupted",
            _ if position == BreakoutPosition::Lost => "breakout-lost",
            (false, ..) => "below-score",
            _ if !job.entry_candidate => "evaluated",
            (_, false, _) => "disabled",
            (_, _, None) => "no-account",
            (_, _, Some(account_revision)) => {
                let mut submitting = result.clone();
                submitting["status"] = json!("submitting");
                let guard = |claim: bool| {
                    if current()
                        && self
                            .store
                            .allow_spike_order(
                                &job.id,
                                &job.owner,
                                job.rule,
                                now_ms(),
                                claim.then_some(&submitting),
                            )
                            .map_err(|error| format!("无法核对异动下单状态：{error}"))?
                    {
                        Ok(())
                    } else {
                        Err("告警已过期或策略设置已变更。".to_owned())
                    }
                };
                let intent = OrderIntent {
                    strategy_id: MARKET_SPIKE_ID.into(),
                    strategy_name: MARKET_SPIKE_NAME.into(),
                    symbol: job.contract.id.clone(),
                    side: job.side,
                    size: OrderSize::ExchangeMinimum,
                    leverage: 1,
                    stop_loss_percent: job.rule.continuation.stop_loss_percent,
                    take_profit_percent: job.rule.continuation.take_profit_percent,
                    limit_exit_percent: Some(job.rule.continuation.limit_exit_percent()),
                    max_hold_seconds: 300,
                    note: format!(
                        "异动延续评分 {} 分（走势评估 {} / 同向主动成交 + 订单簿深度 {} / 成交额加分 {} / 异动前横盘平静度 {}）",
                        score.total,
                        score.breakout_points,
                        score.flow_points,
                        score.turnover_points,
                        score.price_points
                    ),
                };
                match self
                    .trader
                    .submit_guarded(intent, account_revision, Some(RoundOrder {
                        round_id: &job.round_id, signal_id: &job.id, increase: None,
                    }), guard)
                    .await
                {
                    Ok(trade) => {
                        result["tradeId"] = trade["id"].clone();
                        if trade["status"] == "opening" {
                            result["error"] = trade["error"].clone();
                            "unknown"
                        } else {
                            "ordered"
                        }
                    }
                    Err(error) => {
                        result["error"] = json!(error);
                        "failed"
                    }
                }
            }
        };
        result["status"] = json!(status);
        self.store.finish_spike_evaluation(&job.id, &result)
    }
}

async fn historical_quietness(
    binance: &Binance, contract: &Contract, trigger: i64, seconds: i64, hours: u64,
) -> Option<Quietness> {
    let end = (trigger - seconds * 1000).div_euclid(MINUTE_MS) * MINUTE_MS;
    let duration = i64::try_from(hours).ok()?.checked_mul(HOUR_MS)?;
    let start = end.checked_sub(duration)?;
    if start < contract.onboard_at || start <= 0 { return None; }
    let mut cursor = start;
    let mut rows = Vec::new();
    while cursor < end {
        let until = end.min(cursor + 499 * MINUTE_MS);
        let page: Vec<Value> = binance.get(Endpoint::Klines, json!({
            "symbol":contract.id,"interval":"1m","limit":(until-cursor)/MINUTE_MS,
            "startTime":cursor,"endTime":until-1,
        })).await.ok()?;
        if page.len() as i64 != (until - cursor) / MINUTE_MS { return None; }
        rows.extend(page);
        cursor = until;
    }
    measure_quietness(&rows, start, end)
}

fn measure_quietness(rows: &[Value], start: i64, end: i64) -> Option<Quietness> {
    if rows.len() < 2 || end - start != rows.len() as i64 * MINUTE_MS { return None; }
    let mut high = 0.0_f64;
    let mut low = f64::INFINITY;
    let mut max_candle = 0.0_f64;
    let mut first_sum = 0.0;
    let mut last_sum = 0.0;
    let half = rows.len() / 2;
    for (index, row) in rows.iter().enumerate() {
        let time = start + index as i64 * MINUTE_MS;
        if row[0].as_i64()? != time || row[6].as_i64()? != time + MINUTE_MS - 1 { return None; }
        let open = number(&row[1])?;
        let bar_high = number(&row[2])?;
        let bar_low = number(&row[3])?;
        let close = number(&row[4])?;
        if open <= 0.0 || bar_low <= 0.0 || bar_low > open.min(close) || bar_high < open.max(close) { return None; }
        high = high.max(bar_high);
        low = low.min(bar_low);
        max_candle = max_candle.max((bar_high - bar_low) / open * 100.0);
        if index < half { first_sum += close; }
        if index >= rows.len() - half { last_sum += close; }
    }
    let range_percent = (high - low) / low * 100.0;
    let drift_percent = (last_sum / first_sum - 1.0).abs() * 100.0;
    if !range_percent.is_finite() || !drift_percent.is_finite() || !max_candle.is_finite() { return None; }
    let points = |value: f64, full: f64, partial: f64| {
        // Allow only floating-point rounding at an exact threshold.
        if value <= full + 1e-9 { 10 } else if value <= partial + 1e-9 { 5 } else { 0 }
    };
    let range_points = points(range_percent, 5.0, 8.0);
    let drift_points = points(drift_percent, 1.0, 2.0);
    let candle_points = points(max_candle, 1.0, 2.0);
    Some(Quietness {
        start, end, range_percent, drift_percent, max_candle_percent: max_candle,
        range_points, drift_points, candle_points, points: range_points + drift_points + candle_points,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::strategy::Sample;

    #[test]
    fn breakout_observation_reports_taker_flow_and_both_directions_of_price_holding() {
        use BreakoutPosition::{Endangered, Half, Held, Lost, Recovered, Retained};
        for upward in [true, false] {
          let direction = if upward { 1.0 } else { -1.0 };
          let reference: f64 = 100.0;
          let target = reference + direction * 10.0;
          for (worst_progress, last_progress, position) in [
            (1.0, 1.1, Held), (1.0, 1.0, Held),
            (0.9, 1.0, Recovered), (-0.1, 1.1, Recovered),
            (0.7, 0.75, Retained), (0.7, 0.9999, Retained),
            (0.4, 0.5, Half), (0.4, 0.7499, Half),
            (0.0, 0.4999, Endangered), (-0.1, 0.0001, Endangered),
            (0.0, 0.0, Lost), (-0.1, -0.1, Lost),
          ] {
            let worst = reference + direction * 10.0 * worst_progress;
            let last = reference + direction * 10.0 * last_progress;
            let trades = TradeWindow {
                total: 500.0,
                taker_buy: 350.0,
                low: worst.min(last).min(target),
                high: worst.max(last).max(target),
                last: Some(Sample { time: 6_000, price: last }),
            };
            assert_eq!(measure_breakout(trades, target, reference, upward), BreakoutObservation::Ready {
                window_seconds: 5,
                buy_usdt: 350.0,
                sell_usdt: 150.0,
                net_percent: 40.0,
                position,
                target_price: target,
                reference_price: reference,
                worst_price: worst,
                last_price: last,
                last_trade_time: 6_000,
            });
          }
        }
        assert_eq!(measure_breakout(TradeWindow::default(), 110.0, 100.0, true), BreakoutObservation::NoTrades);
    }

    #[test]
    fn turnover_bonus_uses_strict_thresholds_and_ignores_unavailable_or_zero_baselines() {
        for (first, thresholds) in [(true, [100.0, 200.0, 400.0, 700.0, 1000.0]),
            (false, [5.0, 10.0, 20.0, 50.0, 100.0])] {
            let mut previous = 0;
            for (threshold, points) in thresholds.into_iter().zip([3, 5, 10, 15, 20]) {
                assert_eq!(TurnoverBonus::new(first, Some(threshold)).points, previous);
                assert_eq!(TurnoverBonus::new(first, Some(threshold + 0.001)).points, points);
                previous = points;
            }
            for multiple in [None, Some(0.0), Some(f64::INFINITY), Some(f64::NAN), Some(-1.0)] {
                assert_eq!(TurnoverBonus::new(first, multiple).points, 0);
            }
        }
    }

    fn quiet_bars(closes: &[f64], width: f64) -> Vec<Value> {
        closes.iter().enumerate().map(|(index, price)| {
            let time = index as i64 * MINUTE_MS;
            json!([time,price,price+width/2.0,price-width/2.0,price,0,time+MINUTE_MS-1])
        }).collect()
    }

    #[test]
    fn quietness_distinguishes_small_sideways_drift_and_wicks() {
        let flat = quiet_bars(&[100.0,100.1,99.9,100.0], 0.2);
        let quiet = measure_quietness(&flat, 0, 4*MINUTE_MS).unwrap();
        assert_eq!(quiet.points, 30);
        let rising = quiet_bars(&[100.0,102.0,104.0,106.0], 0.2);
        let quiet = measure_quietness(&rising, 0, 4*MINUTE_MS).unwrap();
        assert_eq!(quiet.drift_points, 0);
        let falling = quiet_bars(&[106.0,104.0,102.0,100.0], 0.2);
        assert_eq!(measure_quietness(&falling, 0, 4*MINUTE_MS).unwrap().drift_points, 0);
        let wicks = quiet_bars(&[100.0,100.0,100.0,100.0], 4.0);
        assert_eq!(measure_quietness(&wicks, 0, 4*MINUTE_MS).unwrap().candle_points, 0);
        assert!(measure_quietness(&flat[..3], 0, 4*MINUTE_MS).is_none());
        let mut broken = flat;
        broken[1][0] = json!(0);
        assert!(measure_quietness(&broken, 0, 4*MINUTE_MS).is_none());
    }

    #[test]
    fn quietness_boundaries_and_combined_score_use_30_plus_20_bonus() {
        for (range, expected) in [(5.0,10),(5.01,5),(8.0,5),(8.01,0)] {
            let rows = vec![
                json!([0,100,100,100,100,0,59999]),
                json!([60000,100,100.0+range,100,100,0,119999]),
            ];
            assert_eq!(measure_quietness(&rows, 0, 2*MINUTE_MS).unwrap().range_points, expected);
        }
        for (drift, expected) in [(1.0,10),(1.01,5),(2.0,5),(2.01,0)] {
            let bars = quiet_bars(&[100.0,100.0,100.0+drift,100.0+drift], 0.0);
            assert_eq!(measure_quietness(&bars, 0, 4*MINUTE_MS).unwrap().drift_points, expected);
        }
        for (width, expected) in [(1.0,10),(1.01,5),(2.0,5),(2.01,0)] {
            let bars = quiet_bars(&[100.0,100.0], width);
            assert_eq!(measure_quietness(&bars, 0, 2*MINUTE_MS).unwrap().candle_points, expected);
        }
        let quiet = measure_quietness(&quiet_bars(&[100.0,100.0], 0.1), 0, 2*MINUTE_MS);
        let score = Score::calculate(quiet, TurnoverBonus::new(true, Some(1001.0)),
            BreakoutPosition::Held, FlowScore::new(1,2,75.0,100.0,Side::Long,None));
        assert_eq!(score.total, 120);
        assert_eq!(score.price_points, 30);
        assert_eq!(score.turnover_points, 20);
        assert!(score.allows_entry(BreakoutPosition::Held));
        let score = Score::calculate(None, TurnoverBonus::new(true, None),
            BreakoutPosition::Held, FlowScore::new(1,2,75.0,100.0,Side::Long,None));
        assert_eq!(score.total, 70);
    }

    #[test]
    fn active_flow_and_depth_use_independent_thresholds_and_cap_at_35() {
        for side in [Side::Long, Side::Short] {
            for (share, points) in [(54.99, 0), (55.0, 10), (59.99, 10), (60.0, 15),
                (64.99, 15), (65.0, 20), (69.99, 20), (70.0, 30), (74.99, 30), (75.0, 35)] {
                let buy = if side == Side::Long { share } else { 100.0 - share };
                let flow = FlowScore::new(1, 2, buy, 100.0, side, None);
                assert_eq!(flow.points, points);
                assert_eq!(flow.depth_points, 0);
            }
            for (share, points) in [(59.99, 0), (60.0, 5), (64.99, 5), (65.0, 10),
                (69.99, 10), (70.0, 15), (74.99, 15), (75.0, 20), (79.99, 20),
                (80.0, 25), (100.0, 25)] {
                let bid = if side == Side::Long { share } else { 100.0 - share };
                let depth = DepthEvidence { time: 2, bid_usdt: bid, ask_usdt: 100.0 - bid, bid_levels: 1, ask_levels: 1 };
                let buy = if side == Side::Long { 70.0 } else { 30.0 };
                let flow = FlowScore::new(1, 2, buy, 100.0, side, Some(depth));
                assert_eq!(flow.depth_points, points);
                assert_eq!(flow.depth_max_points, 25);
                assert_eq!(flow.points, (30 + points).min(35));
            }
        }
    }

    #[test]
    fn depth_uses_notional_and_rejects_stale_or_invalid_snapshots() {
        let book = json!({"E":1000,"bids":[["2","10"]],"asks":[["3","10"]]});
        let depth = measure_depth(book.clone(), 1000).unwrap();
        assert_eq!((depth.bid_usdt, depth.ask_usdt), (20.0, 30.0));
        assert!(measure_depth(book, 17000).is_none());
        for book in [
            json!({"E":1000,"bids":[],"asks":[["3","10"]]}),
            json!({"E":1000,"bids":[["4","10"]],"asks":[["3","10"]]}),
            json!({"E":1000,"bids":[["2","-1"]],"asks":[["3","10"]]}),
        ] {
            assert!(measure_depth(book, 1000).is_none());
        }
    }

    #[test]
    fn full_minutes_sum_taker_quote_and_reject_missing_duplicate_or_invalid_candles() {
        let bar = |time, total, buy| json!([time,0,0,0,0,0,time+59999,total,0,0,buy]);
        let rows = vec![bar(60000, 100.0, 60.0), bar(120000, 200.0, 80.0)];
        assert_eq!(minute_flow(&rows, 60000, 180000), Some((140.0, 300.0)));
        assert_eq!(minute_flow(&[], 60000, 60000), Some((0.0, 0.0)));
        assert!(minute_flow(&rows[..1], 60000, 180000).is_none());
        assert!(minute_flow(&[rows[0].clone(), rows[0].clone()], 60000, 180000).is_none());
        assert!(minute_flow(&[bar(60000, 100.0, 101.0)], 60000, 120000).is_none());
        assert!(minute_flow(&[bar(60000, 100.0, -1.0)], 60000, 120000).is_none());
    }
}
