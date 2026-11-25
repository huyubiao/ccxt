use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{watch, Semaphore};

use crate::binance::{number, Binance, Contract, Endpoint};
use crate::liquidation::Loader;
use crate::now_ms;
use crate::store::{Result, Store};
use crate::strategy::{ContinuationRule, Rule, MARKET_SPIKE_ID, MARKET_SPIKE_NAME};
use crate::trading::{OrderIntent, OrderSize, Side, Trader};

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const MAX_ALERT_AGE_MS: i64 = 45_000;
const ORDER_SCORE: u8 = 80;
const NEAR_PERCENT: f64 = 5.0;
const MIN_NEAR_SHARE: f64 = 0.2;

pub struct Evaluation {
    pub id: String,
    pub contract: Contract,
    pub trigger_time: i64,
    pub side: Side,
    pub turnover: f64,
    pub rule: Rule,
    pub owner: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Score {
    price_points: u8,
    turnover_points: u8,
    liquidation_points: u8,
    total: u8,
    range_percent: Option<f64>,
    dominant_side: Option<Side>,
    near_share_percent: Option<f64>,
}

impl Score {
    fn calculate(
        rule: ContinuationRule,
        side: Side,
        range: Option<f64>,
        turnover: f64,
        model: Option<&Value>,
    ) -> Self {
        let price_points = if range.is_some_and(|range| range <= rule.max_range_percent) {
            60
        } else {
            0
        };
        let turnover_points = turnover_points(turnover, rule.turnover_multiple);
        let risk = model.and_then(|model| liquidation_risk(model, side));
        let liquidation_points = if risk
            .is_some_and(|(dominant, near)| dominant == Some(side) && near >= MIN_NEAR_SHARE)
        {
            10
        } else {
            0
        };
        Self {
            price_points,
            turnover_points,
            liquidation_points,
            total: price_points + turnover_points + liquidation_points,
            range_percent: range,
            dominant_side: risk.and_then(|(dominant, _)| dominant),
            near_share_percent: risk.map(|(_, near)| 100.0 * near),
        }
    }
}

fn turnover_points(multiple: f64, target: f64) -> u8 {
    let tier = (multiple / target).floor().clamp(0.0, 3.0) as u8;
    10 * tier
}

fn liquidation_risk(model: &Value, side: Side) -> Option<(Option<Side>, f64)> {
    let mut totals = [0.0_f64; 2];
    let mut near = 0.0;
    let index = usize::from(side == Side::Short);
    for level in model["levels"].as_array()? {
        let bucket = match level["side"].as_str()? {
            "long" => 0,
            "short" => 1,
            _ => return None,
        };
        let amount = number(&level["estimatedLiquidationUsdt"]).filter(|amount| *amount > 0.0)?;
        let distance = number(&level["distancePercent"])?;
        totals[bucket] += amount;
        if bucket == index && distance.abs() <= NEAR_PERCENT {
            near += amount;
        }
    }
    if !totals.iter().all(|amount| amount.is_finite()) || totals == [0.0; 2] {
        return None;
    }
    let dominant = match totals[0].total_cmp(&totals[1]) {
        std::cmp::Ordering::Greater => Some(Side::Long),
        std::cmp::Ordering::Less => Some(Side::Short),
        std::cmp::Ordering::Equal => None,
    };
    Some((
        dominant,
        if totals[index] > 0.0 {
            near / totals[index]
        } else {
            0.0
        },
    ))
}

pub struct Evaluator {
    pub store: Arc<Store>,
    pub binance: Arc<Binance>,
    pub liquidation: Arc<Loader>,
    pub trader: Arc<Trader>,
    pub stop: watch::Receiver<bool>,
    pub slots: Semaphore,
}

impl Evaluator {
    pub async fn evaluate(&self, job: Evaluation) -> Result<()> {
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
        let range = tokio::time::timeout(
            Duration::from_secs(12),
            historical_range(&self.binance, &job),
        )
        .await
        .ok()
        .flatten();
        let mut score =
            Score::calculate(job.rule.continuation, job.side, range, job.turnover, None);
        if score.price_points > 0 && score.turnover_points > 0 && current() {
            let model = tokio::time::timeout(
                Duration::from_secs(8),
                self.liquidation.contract_levels(&job.contract.id),
            )
            .await
            .ok()
            .and_then(|result| result.ok());
            score = Score::calculate(
                job.rule.continuation,
                job.side,
                range,
                job.turnover,
                model.as_ref(),
            );
        }
        let mut result = json!({"score":score,"side":job.side,"target":ORDER_SCORE});
        let status = match (
            range,
            score.total >= ORDER_SCORE,
            job.rule.continuation.auto_trade,
            account_revision,
        ) {
            _ if !current() => "interrupted",
            (None, ..) => "unavailable",
            (_, false, ..) => "below-score",
            (_, _, false, _) => "disabled",
            (_, _, _, None) => "no-account",
            (_, _, _, Some(account_revision)) => {
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
                        "异动延续评分 {} 分（涨跌幅 {} / 成交额 {} / 强平估算 {}）",
                        score.total,
                        score.price_points,
                        score.turnover_points,
                        score.liquidation_points
                    ),
                };
                match self
                    .trader
                    .submit_guarded(intent, account_revision, guard)
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

    #[test]
    fn volume_tiers_and_price_range_control_the_order_score() {
        let rule = ContinuationRule::default();
        for (multiple, points) in [
            (4.99, 0),
            (5.0, 10),
            (9.99, 10),
            (10.0, 20),
            (14.99, 20),
            (15.0, 30),
            (99.0, 30),
        ] {
            assert_eq!(turnover_points(multiple, rule.turnover_multiple), points);
        }
        assert_eq!(
            Score::calculate(rule, Side::Long, Some(5.0), 10.0, None).total,
            ORDER_SCORE
        );
        assert_eq!(
            Score::calculate(rule, Side::Long, Some(5.01), 15.0, None).total,
            30
        );
        assert_eq!(
            Score::calculate(rule, Side::Short, None, 15.0, None).total,
            30
        );
    }

    #[test]
    fn liquidation_points_require_the_requested_side_and_a_nearby_concentration() {
        let rule = ContinuationRule::default();
        let levels = |side: &str, other: &str, distance: f64| {
            json!({"levels":[
            {"side":side,"estimatedLiquidationUsdt":20,"distancePercent":distance},
            {"side":side,"estimatedLiquidationUsdt":80,"distancePercent":12},
            {"side":other,"estimatedLiquidationUsdt":50,"distancePercent":3}]})
        };
        let short = levels("short", "long", 5.0);
        let long = levels("long", "short", -5.0);
        let distant = levels("short", "long", 5.01);
        assert_eq!(
            Score::calculate(rule, Side::Short, Some(2.0), 5.0, Some(&short)).total,
            ORDER_SCORE
        );
        assert_eq!(
            Score::calculate(rule, Side::Long, Some(2.0), 5.0, Some(&long)).total,
            ORDER_SCORE
        );
        assert_eq!(
            Score::calculate(rule, Side::Long, Some(2.0), 5.0, Some(&short)).total,
            70
        );
        assert_eq!(
            Score::calculate(rule, Side::Short, Some(2.0), 5.0, Some(&distant)).total,
            70
        );
    }
}
