use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{oneshot, watch, Semaphore};

use crate::binance::{number, Binance, Contract, Endpoint, TradeWindow, VOLUME_DELAY_MS};
use crate::now_ms;
use crate::store::{Result, Store};
use crate::strategy::{ContinuationRule, Move, Rule, Volume, MARKET_SPIKE_ID, MARKET_SPIKE_NAME};
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
        Ok(Ok(trades)) => measure_breakout(trades, movement.target, upward),
        _ => BreakoutObservation::Unavailable,
    }
}

fn measure_breakout(trades: TradeWindow, target_price: f64, upward: bool) -> BreakoutObservation {
    let Some(last) = trades.last else {
        return BreakoutObservation::NoTrades;
    };
    let on_breakout_side = |price: f64| {
        (price - target_price).abs() <= f64::EPSILON * price.max(target_price) * 4.0
            || if upward {
                price > target_price
            } else {
                price < target_price
            }
    };
    let worst_price = if upward { trades.low } else { trades.high };
    let position = if !on_breakout_side(last.price) {
        BreakoutPosition::Lost
    } else if !on_breakout_side(worst_price) {
        BreakoutPosition::Recovered
    } else {
        BreakoutPosition::Held
    };
    let sell_usdt = trades.total - trades.taker_buy;
    BreakoutObservation::Ready {
        window_seconds: BREAKOUT_WINDOW_MS / 1_000,
        buy_usdt: trades.taker_buy,
        sell_usdt,
        net_percent: (trades.taker_buy - sell_usdt) / trades.total * 100.0,
        position,
        target_price,
        last_price: last.price,
        last_trade_time: last.time,
    }
}

pub struct Evaluation {
    pub id: String,
    pub round_id: String,
    pub contract: Contract,
    pub trigger_time: i64,
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
}

impl Score {
    fn calculate(
        rule: ContinuationRule,
        side: Side,
        range: Option<f64>,
        volume: Volume,
        position: BreakoutPosition,
        net_percent: f64,
    ) -> Self {
        let breakout_points = match position {
            BreakoutPosition::Held => 35,
            BreakoutPosition::Recovered => 20,
            BreakoutPosition::Lost => 0,
        };
        let aligned_net = if side == Side::Long { net_percent } else { -net_percent };
        let aligned_share = ((100.0 + aligned_net) * 50.0).round() / 100.0;
        let flow_points = match aligned_share {
            share if share >= 70.0 => 35,
            share if share >= 65.0 => 30,
            share if share >= 60.0 => 20,
            share if share >= 55.0 => 10,
            _ => 0,
        };
        let price_points = match range {
            Some(range) if range <= rule.max_range_percent => 10,
            Some(range) if range <= 2.0 * rule.max_range_percent => 5,
            _ => 0,
        };
        let turnover_points = turnover_points(volume, rule.turnover_multiple);
        Self {
            breakout_points,
            flow_points,
            price_points,
            turnover_points,
            total: breakout_points + flow_points + price_points + turnover_points,
            range_percent: range,
        }
    }

    fn allows_entry(&self, position: BreakoutPosition) -> bool {
        position != BreakoutPosition::Lost && self.total >= ORDER_SCORE
    }
}

fn turnover_points(volume: Volume, target: f64) -> u8 {
    let tier = (volume.multiple.unwrap_or_default() / target).floor().clamp(0.0, 3.0) as u8;
    let absolute = match volume.turnover {
        Some(amount) if amount >= 100_000.0 => 5,
        Some(amount) if amount >= 10_000.0 => 3,
        _ => 0,
    };
    5 * tier + absolute
}

pub struct Evaluator {
    pub store: Arc<Store>,
    pub binance: Arc<Binance>,
    pub trader: Arc<Trader>,
    pub stop: watch::Receiver<bool>,
    pub slots: Semaphore,
}

impl Evaluator {
    pub async fn evaluate(&self, mut job: Evaluation) -> Result<()> {
        let account_revision = if job.rule.continuation.auto_trade {
            self.trader.auto_account_revision().await
        } else {
            None
        };
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
        let (range, observation) = tokio::join!(
            tokio::time::timeout(Duration::from_secs(12), historical_range(&self.binance, &job)),
            observation,
        );
        let Ok(BreakoutObservation::Ready { position, net_percent, .. }) = observation else {
            let status = if current() { "observation-unavailable" } else { "interrupted" };
            return self.store.finish_spike_evaluation(&job.id, &json!({"status":status,"side":job.side,"target":ORDER_SCORE}));
        };
        let score = Score::calculate(
            job.rule.continuation, job.side, range.ok().flatten(), job.volume, position, net_percent,
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
                        "异动延续评分 {} 分（突破 {} / 主动买卖 {} / 成交额 {} / 历史振幅 {}）",
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

async fn historical_range(binance: &Binance, job: &Evaluation) -> Option<f64> {
    let end =
        (job.trigger_time - i64::from(job.rule.seconds) * 1_000).div_euclid(MINUTE_MS) * MINUTE_MS;
    let start = end - i64::from(job.rule.continuation.lookback_hours) * HOUR_MS;
    if start < job.contract.onboard_at || start <= 0 {
        return None;
    }
    let mut cursor = start;
    let mut low = f64::INFINITY;
    let mut high = 0.0_f64;
    while cursor < end {
        let hours = if cursor % HOUR_MS == 0 {
            (end - cursor) / HOUR_MS
        } else {
            0
        };
        let (step, interval, count) = if hours > 0 {
            (HOUR_MS, "1h", hours.min(499))
        } else {
            let next_hour = (cursor.div_euclid(HOUR_MS) + 1) * HOUR_MS;
            (MINUTE_MS, "1m", (end.min(next_hour) - cursor) / MINUTE_MS)
        };
        let until = cursor + count * step;
        let rows: Vec<Value> = binance
            .get(
                Endpoint::Klines,
                json!({"symbol":job.contract.id,
            "interval":interval,"limit":count,"startTime":cursor,"endTime":until-1}),
            )
            .await
            .ok()?;
        if rows.len() as i64 != count {
            return None;
        }
        for row in rows {
            let bar_high = number(&row[2])?;
            let bar_low = number(&row[3]).filter(|low| *low > 0.0 && *low <= bar_high)?;
            if row[0].as_i64()? != cursor || row[6].as_i64()? != cursor + step - 1 {
                return None;
            }
            low = low.min(bar_low);
            high = high.max(bar_high);
            cursor += step;
        }
    }
    let range = (high - low) / low * 100.0;
    range.is_finite().then_some(range)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::strategy::Sample;

    #[test]
    fn breakout_observation_reports_taker_flow_and_both_directions_of_price_holding() {
        use BreakoutPosition::{Held, Lost, Recovered};
        for (upward, low, high, last, position) in [
            (true, 105.0, 106.0, 106.0, Held),
            (true, 103.0, 106.0, 105.0, Recovered),
            (true, 103.0, 106.0, 103.0, Lost),
            (false, 104.0, 105.0, 104.0, Held),
            (false, 104.0, 106.0, 105.0, Recovered),
            (false, 104.0, 106.0, 106.0, Lost),
        ] {
            let trades = TradeWindow {
                total: 500.0,
                taker_buy: 350.0,
                low,
                high,
                last: Some(Sample { time: 6_000, price: last }),
            };
            assert_eq!(measure_breakout(trades, 105.0, upward), BreakoutObservation::Ready {
                window_seconds: 5,
                buy_usdt: 350.0,
                sell_usdt: 150.0,
                net_percent: 40.0,
                position,
                target_price: 105.0,
                last_price: last,
                last_trade_time: 6_000,
            });
        }
        assert_eq!(measure_breakout(TradeWindow::default(), 105.0, true), BreakoutObservation::NoTrades);
    }

    #[test]
    fn turnover_weights_relative_and_absolute_volume() {
        let rule = ContinuationRule::default();
        for (amount, multiple, points) in [
            (9_999.0, 4.99, 0),
            (10_000.0, 5.0, 8),
            (99_999.0, 10.0, 13),
            (100_000.0, 14.99, 15),
            (100_000.0, 15.0, 20),
        ] {
            let volume = Volume { turnover: Some(amount), baseline: None, multiple: Some(multiple) };
            assert_eq!(turnover_points(volume, rule.turnover_multiple), points);
        }
    }

    #[test]
    fn high_or_missing_historical_range_can_pass_with_a_held_breakout_and_aligned_flow() {
        use BreakoutPosition::{Held, Lost, Recovered};
        let rule = ContinuationRule::default();
        let volume = Volume::new(Some(150_000.0), Some(10_000.0));
        for (side, net_percent) in [(Side::Long, 40.0), (Side::Short, -40.0)] {
            for (range, price_points) in [(Some(5.0), 10), (Some(10.0), 5), (Some(40.54), 0), (None, 0)] {
                let score = Score::calculate(rule, side, range, volume, Held, net_percent);
                assert_eq!(score.total, 90 + price_points);
                assert_eq!(score.price_points, price_points);
                assert!(score.allows_entry(Held));
            }
            let opposite = Score::calculate(rule, side, Some(5.0), volume, Held, -net_percent);
            assert_eq!(opposite.flow_points, 0);
            assert!(!opposite.allows_entry(Held));
            let lost = Score::calculate(rule, side, Some(5.0), volume, Lost, net_percent);
            assert_eq!(lost.breakout_points, 0);
            assert!(!lost.allows_entry(Lost));
            let recovered = Score::calculate(rule, side, Some(10.0), volume, Recovered, net_percent);
            assert_eq!(recovered.total, ORDER_SCORE);
            assert!(recovered.allows_entry(Recovered));
        }
        for (net_percent, flow_points) in [(0.0, 0), (10.0, 10), (20.0, 20), (30.0, 30), (40.0, 35)] {
            let score = Score::calculate(rule, Side::Long, None, volume, Held, net_percent);
            assert_eq!(score.flow_points, flow_points);
        }
    }
}
